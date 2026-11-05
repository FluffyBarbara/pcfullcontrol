'use strict';
// Удалённое управление экраном ПК с телефона.
// Видео идёт по WebRTC (до 120 кадр/с, аппаратное декодирование), команды — по каналу данных того же
// соединения, поэтому клики и курсор почти без задержки. Если WebRTC недоступен — режим совместимости (JPEG).
//
// Касание: нажатие — клик, удержание — правый клик, палец — прокрутка (или перетаскивание), два пальца — масштаб.
// Тачпад:  палец двигает курсор, нажатие — клик, два пальца — прокрутка, нажатие двумя — правый клик,
//          удержание и движение — перетаскивание, разведение пальцев — масштаб.
(() => {
  const FALLBACK_PRESETS = [
    { id: 'auto', name: 'Авто', desc: '60 кадр/с, чёткая картинка', fps: 60 },
    { id: 'quality', name: 'Максимум чёткости', desc: 'Исходное разрешение, 60 кадр/с', fps: 60 },
    { id: 'smooth', name: 'Плавность 120', desc: 'До 120 кадр/с в Full HD', fps: 120 },
    { id: 'eco', name: 'Экономия', desc: '30 кадр/с, HD — для слабого Wi-Fi', fps: 30 },
  ];
  const JPEG_Q = { eco: { w: 960, q: 45 }, auto: { w: 1280, q: 60 }, quality: { w: 1920, q: 75 }, smooth: { w: 1280, q: 55 } };
  const SENS = { slow: 0.9, normal: 1.5, fast: 2.3 };
  const MOD_ORDER = ['ctrl', 'alt', 'shift', 'win'];
  const pref = (k, d) => store.get('rc_' + k) || d;
  const setPref = (k, v) => store.set('rc_' + k, v);

  const rc = {
    open: false, gen: 0, monitor: 1, displays: [], presets: FALLBACK_PRESETS,
    preset: pref('preset', 'auto'), input: pref('input', 'touch'), sens: pref('sens', 'normal'),
    dragMode: false, rightNext: false, zoom: 1, tx: 0, ty: 0, base: { x: 0, y: 0, w: 0, h: 0 },
    transport: null, pc: null, dc: null, sid: null, audio: false, reconnecting: false,
    prevUrl: null, frames: [], queue: Promise.resolve(), httpBusy: false, wakeLock: null,
    mods: new Set(), cursor: null, host: {}, view: {}, relX: 0, relY: 0, relRaf: 0, full: false,
  };
  const $r = (s) => document.querySelector(s);
  const stage = () => $r('#rc-stage');
  const canvas = () => $r('#rc-canvas');
  const video = () => $r('#rc-video');
  const img = () => $r('#rc-img');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const presetById = (id) => rc.presets.find((p) => p.id === id) || rc.presets[0];

  // ---------------- отправка команд ----------------
  const dcOpen = () => rc.dc && rc.dc.readyState === 'open';
  const wsOpen = () => rc.ws && rc.ws.readyState === 1;

  function send(cmd) {
    const c = { ...cmd, monitor: rc.monitor };
    if (wsOpen()) {
      try { rc.ws.send(JSON.stringify({ type: 'input', cmd: c })); return Promise.resolve(); } catch (e) { /* ниже — по HTTP */ }
    }
    if (dcOpen()) {
      try { rc.dc.send(JSON.stringify({ type: 'input', cmd: c })); return Promise.resolve(); } catch (e) { /* ниже — по HTTP */ }
    }
    rc.httpBusy = true;
    rc.queue = rc.queue.then(() => fetch('/api/remote/input', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(c),
    }).then(async (r) => {
      if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error || 'Ошибка управления', 'err'); }
    }).catch(() => {})).then(() => { rc.httpBusy = false; });
    return rc.queue;
  }

  function dcSend(msg) {
    if (wsOpen()) { try { rc.ws.send(JSON.stringify(msg)); return true; } catch (e) { return false; } }
    if (!dcOpen()) return false;
    try { rc.dc.send(JSON.stringify(msg)); return true; } catch (e) { return false; }
  }

  /** Горячая клавиша с учётом зажатых Ctrl/Alt/Shift/Win. */
  function key(k) {
    haptic(8);
    const keys = [...MOD_ORDER.filter((m) => rc.mods.has(m)), ...k.split('+')];
    clearMods();
    return send({ type: 'key', keys: [...new Set(keys)].join('+') });
  }

  // Сдвиг курсора в режиме тачпада: копим и отправляем раз в кадр
  function relMove(dx, dy) {
    rc.relX += dx;
    rc.relY += dy;
    if (!rc.relRaf) rc.relRaf = requestAnimationFrame(flushRel);
  }
  function flushRel() {
    rc.relRaf = 0;
    if (!dcOpen() && !wsOpen() && rc.httpBusy) { rc.relRaf = requestAnimationFrame(flushRel); return; }
    const ix = Math.trunc(rc.relX);
    const iy = Math.trunc(rc.relY);
    if (!ix && !iy) return;
    rc.relX -= ix;
    rc.relY -= iy;
    send({ type: 'rel', dx: ix, dy: iy });
  }

  // ---------------- WebRTC ----------------
  function waitFor(cond, ms, fail = () => false) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const tick = () => {
        if (cond()) return resolve();
        if (fail()) return reject(new Error('Соединение не установлено'));
        if (performance.now() - t0 > ms) return reject(new Error('Нет ответа'));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function gathered(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
    });
  }

  async function connectRtc(gen) {
    const start = await api('/api/remote/rtc/start', { json: { monitor: rc.monitor, preset: rc.preset, audio: true } });
    if (gen !== rc.gen) { stopSession(start.sid); return false; }
    rc.sid = start.sid;
    rc.audio = !!start.audio;
    // Через интернет нужны STUN-серверы, чтобы найти путь к домашнему ПК
    const ice = (typeof INFO !== 'undefined' && INFO && INFO.iceServers) || [];
    const far = ice.length > 0;
    const pc = new RTCPeerConnection({ iceServers: ice });
    rc.pc = pc;
    pc.ontrack = (e) => {
      const v = video();
      const ms = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      if (v.srcObject !== ms) v.srcObject = ms;
      try { e.receiver.jitterBufferTarget = 0; } catch (err) { /* не поддерживается */ }
      try { e.receiver.playoutDelayHint = 0; } catch (err) { /* не поддерживается */ }
      v.play().catch(() => {});
    };
    pc.ondatachannel = (e) => {
      rc.dc = e.channel;
      e.channel.onmessage = (m) => onDc(m.data);
    };
    pc.onconnectionstatechange = () => onPcState(pc, gen);
    await pc.setRemoteDescription({ type: 'offer', sdp: start.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc, far ? 3000 : 800);
    if (gen !== rc.gen) return false;
    await api('/api/remote/rtc/answer', { json: { sid: rc.sid, sdp: pc.localDescription.sdp } });
    await waitFor(() => ['connected', 'completed'].includes(pc.iceConnectionState), far ? 15000 : 9000, () => pc.iceConnectionState === 'failed' || gen !== rc.gen);
    await waitFor(() => video().videoWidth > 0, 8000, () => gen !== rc.gen);
    updateSound();
    return gen === rc.gen;
  }

  function stopSession(sid) {
    if (!sid) return;
    fetch('/api/remote/rtc/stop', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ sid }), keepalive: true,
    }).catch(() => {});
  }


  // ---------------- поток H.264 через WebSocket (интернет, любые сети) ----------------
  // ПК кодирует видео сам (видеокарта), телефон декодирует аппаратно (WebCodecs) и рисует на холсте.
  // Работает через туннель там, где прямое соединение WebRTC не проходит (мобильные операторы, NAT).
  const canWs = () => 'VideoDecoder' in window && window.isSecureContext;

  async function connectWs(gen) {
    if (!canWs()) throw new Error('Телефон не поддерживает этот режим');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/remote/ws?token=${encodeURIComponent(token)}&monitor=${rc.monitor}&preset=${rc.preset}`);
    ws.binaryType = 'arraybuffer';
    rc.ws = ws;
    rc.wsFrames = 0;
    const cv = $r('#rc-cv');
    const g = cv.getContext('2d', { alpha: false, desynchronized: true });
    let dec = null;
    let codec = null;
    let decCfg = null; // настройки декодера: аппаратный, если телефон умеет, иначе программный
    let waitKey = true;
    let lastAsk = 0;
    const askKey = () => { if (Date.now() - lastAsk > 400 && ws.readyState === 1) { lastAsk = Date.now(); ws.send(JSON.stringify({ type: 'keyframe' })); } };
    const mkDec = () => {
      dec = new VideoDecoder({
        output: (f) => {
          if (cv.width !== f.displayWidth || cv.height !== f.displayHeight) { cv.width = f.displayWidth; cv.height = f.displayHeight; layout(false); }
          g.drawImage(f, 0, 0, cv.width, cv.height);
          f.close();
          rc.wsFrames++;
        },
        error: () => { waitKey = true; dec = null; askKey(); },
      });
      dec.configure(decCfg);
    };
    const pickDecoder = async (c) => {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        const cfg = { codec: c, optimizeForLatency: true, hardwareAcceleration };
        try { if ((await VideoDecoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { /* следующий */ }
      }
      return null;
    };
    ws.onmessage = (ev) => {
      if (gen !== rc.gen) return;
      if (typeof ev.data === 'string') {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'config') {
          codec = m.codec;
          decCfg = null;
          try { if (dec && dec.state !== 'closed') dec.close(); } catch (e) { /* ignore */ }
          dec = null;
          waitKey = true;
          pickDecoder(m.codec).then((cfg) => {
            if (codec !== m.codec) return;
            decCfg = cfg;
            if (!cfg) showHint('Телефон не умеет показывать этот видеопоток', 4000); else askKey();
          });
          rc.host = { ...rc.host, codec: m.codec.startsWith('avc1') ? 'H264' : m.codec, hw: m.hw, target: m.fps };
        } else if (m.type === 'pong') {
          rc.wsPing = Math.round(performance.now() - m.t);
        } else onDc(ev.data);
        return;
      }
      const buf = ev.data;
      if (!codec || !decCfg || buf.byteLength < 14) return;
      const v = new DataView(buf);
      const key = (v.getUint8(0) & 1) === 1;
      if (waitKey && !key) { askKey(); return; }
      if (!dec || dec.state === 'closed') { if (!key) { askKey(); return; } mkDec(); }
      // Телефон не успевает декодировать — пропускаем до следующего опорного кадра
      if (!key && dec.decodeQueueSize > 4) { waitKey = true; askKey(); return; }
      waitKey = false;
      try {
        dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: v.getFloat64(5, true), data: new Uint8Array(buf, 13) }));
      } catch (e) { waitKey = true; askKey(); }
    };
    ws.onclose = () => {
      if (rc.ws !== ws || gen !== rc.gen || !rc.open) return;
      rc.ws = null;
      reconnect(gen);
    };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Нет ответа')), 10000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('Не удалось подключиться')); }, { once: true });
    });
    await waitFor(() => rc.wsFrames > 0, 12000, () => gen !== rc.gen || ws.readyState > 1);
    return gen === rc.gen;
  }

  function cleanupWs() {
    const ws = rc.ws;
    rc.ws = null;
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
  }

  // Пинг и кадры в секунду для режима WebSocket
  async function wsStatsLoop(gen) {
    let last = rc.wsFrames || 0;
    let t = performance.now();
    while (rc.open && gen === rc.gen && rc.transport === 'ws') {
      await sleep(1000);
      if (wsOpen()) rc.ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
      const now = performance.now();
      const fps = Math.round(((rc.wsFrames - last) * 1000) / (now - t));
      last = rc.wsFrames;
      t = now;
      const cv = $r('#rc-cv');
      rc.view = { fps: Math.max(0, fps), w: cv.width, h: cv.height, ping: rc.wsPing != null ? rc.wsPing : null };
      renderStatus();
    }
  }

  function cleanupRtc() {
    dcSend({ type: 'bye' });
    try { if (rc.pc) rc.pc.close(); } catch (e) { /* ignore */ }
    stopSession(rc.sid);
    rc.pc = null;
    rc.dc = null;
    rc.sid = null;
    rc.host = {};
    const v = video();
    try { v.pause(); } catch (e) { /* ignore */ }
    v.srcObject = null;
  }

  function onPcState(pc, gen) {
    if (pc !== rc.pc || gen !== rc.gen || !rc.open) return;
    const st = pc.connectionState || pc.iceConnectionState;
    if (st === 'failed') reconnect(gen);
    else if (st === 'disconnected') {
      setStatus('связь прерывается…', 'wait');
      setTimeout(() => { if (pc === rc.pc && ['disconnected', 'failed'].includes(pc.connectionState)) reconnect(gen); }, 3000);
    }
  }

  async function reconnect(gen) {
    if (rc.reconnecting || gen !== rc.gen || !rc.open) return;
    if (rc.transport === 'ws') {
      rc.reconnecting = true;
      setStatus('переподключение…', 'wait');
      cleanupWs();
      let ok2 = false;
      for (let i = 0; i < 3 && !ok2 && gen === rc.gen; i++) {
        try { ok2 = await connectWs(gen); } catch (e) { cleanupWs(); await sleep(1500); }
      }
      rc.reconnecting = false;
      if (gen !== rc.gen) return;
      if (!ok2) { startJpeg(gen); showHint('Связь слабая — включён режим совместимости', 4000); }
      return;
    }
    rc.reconnecting = true;
    setStatus('переподключение…', 'wait');
    cleanupRtc();
    let ok = false;
    for (let i = 0; i < 2 && !ok && gen === rc.gen; i++) {
      try { ok = await connectRtc(gen); } catch (e) { cleanupRtc(); await sleep(1000); }
    }
    rc.reconnecting = false;
    if (gen !== rc.gen) return;
    if (!ok) { cleanupRtc(); startJpeg(gen); showHint('Видео прервалось — включён режим совместимости', 4000); }
  }

  function onDc(data) {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    switch (m.type) {
      case 'hello': rc.audio = !!m.audio; updateSound(); break;
      case 'stats': rc.host = m; break;
      case 'cursor': rc.cursor = m.p; updateCursor(); break;
      case 'error': toast(m.message, 'err'); break;
      case 'monitor': rc.monitor = m.index; $r('#rc-monitor-num').textContent = String(m.index); break;
      default: break;
    }
  }

  async function statsLoop(gen) {
    let last = null;
    while (rc.open && gen === rc.gen && rc.transport === 'rtc') {
      await sleep(1000);
      const pc = rc.pc;
      if (!pc) { last = null; continue; }
      try {
        const r = await pc.getStats();
        let inb = null;
        let pair = null;
        r.forEach((x) => {
          if (x.type === 'inbound-rtp' && x.kind === 'video') inb = x;
          if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded') pair = x;
        });
        if (!inb) continue;
        const now = performance.now();
        let fps = inb.framesPerSecond || 0;
        if (last && inb.framesDecoded >= last.f) fps = ((inb.framesDecoded - last.f) * 1000) / (now - last.t);
        last = { f: inb.framesDecoded || 0, t: now };
        rc.view = {
          fps: Math.round(fps), w: inb.frameWidth || video().videoWidth, h: inb.frameHeight || video().videoHeight,
          ping: pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
          dropped: inb.framesDropped || 0,
        };
        renderStatus();
      } catch (e) { /* соединение закрывается */ }
    }
  }

  // ---------------- режим совместимости (JPEG) ----------------
  function startJpeg(gen) {
    rc.transport = 'jpeg';
    showMedia();
    jpegLoop(gen);
  }

  async function jpegLoop(gen) {
    while (rc.open && gen === rc.gen && rc.transport === 'jpeg') {
      const t0 = performance.now();
      const Q = JPEG_Q[rc.preset] || JPEG_Q.auto;
      try {
        const r = await fetch(`/api/remote/frame?monitor=${rc.monitor}&w=${Q.w}&q=${Q.q}`, {
          headers: { Authorization: 'Bearer ' + token }, cache: 'no-store',
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || 'Нет изображения');
        }
        const cur = r.headers.get('X-Cursor');
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        await new Promise((res) => { img().onload = res; img().onerror = res; img().src = url; });
        if (rc.prevUrl) URL.revokeObjectURL(rc.prevUrl);
        rc.prevUrl = url;
        layout(false);
        rc.cursor = cur ? cur.split(',').map(Number) : null;
        updateCursor();
        rc.frames.push(performance.now());
        rc.frames = rc.frames.filter((t) => performance.now() - t < 2000);
        rc.view = { fps: Math.round(rc.frames.length / 2), w: img().naturalWidth, h: img().naturalHeight };
        renderStatus();
        $r('#rc-error').classList.add('hidden');
      } catch (e) {
        setStatus('нет связи', 'off');
        const err = $r('#rc-error');
        err.textContent = e.message === 'Failed to fetch' ? 'Нет связи с компьютером' : e.message;
        err.classList.remove('hidden');
        await sleep(1500);
      }
      const dt = performance.now() - t0;
      if (dt < 60) await sleep(60 - dt);
      while (rc.open && document.hidden) await sleep(500);
    }
  }

  // ---------------- статус ----------------
  function setStatus(text, state) {
    $r('#rc-fps').textContent = text;
    $r('#rc-dot').className = 'dot ' + (state === 'on' ? 'on' : state === 'off' ? 'off' : 'wait');
  }

  function renderStatus() {
    const v = rc.view;
    if (!v || v.fps == null || !rc.open) return;
    const res = v.h ? ` · ${v.h}p` : '';
    const ping = v.ping != null ? ` · ${v.ping} мс` : '';
    if (rc.transport === 'rtc') setStatus(`${v.fps} к/с${res}${ping}`, 'on');
    else if (rc.transport === 'ws') setStatus(`${v.fps} к/с${res}${ping} · через интернет`, 'on');
    else setStatus(`${v.fps} к/с${res} · совместимость`, 'on');
  }

  let hintTimer = null;
  function showHint(text, ms = 3000) {
    const h = $r('#rc-hint');
    h.textContent = text;
    h.classList.remove('hidden');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => h.classList.add('hidden'), ms);
  }

  function showMedia() {
    const rtc = rc.transport === 'rtc';
    video().classList.toggle('hidden', !rtc);
    $r('#rc-cv').classList.toggle('hidden', rc.transport !== 'ws');
    img().classList.toggle('hidden', rc.transport !== 'jpeg');
    updateSound();
    layout(true);
  }

  function updateSound() {
    const b = $r('#rc-sound');
    const has = rc.transport === 'rtc' && rc.audio;
    b.classList.toggle('hidden', !has);
    const on = has && !video().muted;
    b.classList.toggle('active', on);
    b.replaceChildren(ic(on ? 'volUp' : 'mute', 18));
  }

  // ---------------- раскладка, масштаб, курсор ----------------
  function mediaSize() {
    if (rc.transport === 'rtc') return [video().videoWidth || 16, video().videoHeight || 9];
    if (rc.transport === 'ws') return [$r('#rc-cv').width || 16, $r('#rc-cv').height || 9];
    return [img().naturalWidth || 16, img().naturalHeight || 9];
  }

  function layout(resetZoom) {
    const st = stage().getBoundingClientRect();
    const [iw, ih] = mediaSize();
    const k = Math.min(st.width / iw, st.height / ih);
    const w = Math.round(iw * k);
    const h = Math.round(ih * k);
    const b = { x: Math.round((st.width - w) / 2), y: Math.round((st.height - h) / 2), w, h };
    if (b.w !== rc.base.w || b.h !== rc.base.h || b.x !== rc.base.x || b.y !== rc.base.y || resetZoom) {
      rc.base = b;
      const cv = canvas();
      cv.style.left = b.x + 'px';
      cv.style.top = b.y + 'px';
      cv.style.width = b.w + 'px';
      cv.style.height = b.h + 'px';
      if (resetZoom) { rc.zoom = 1; rc.tx = 0; rc.ty = 0; }
      applyTransform();
    }
  }

  function applyTransform() {
    const b = rc.base;
    rc.zoom = Math.max(1, Math.min(5, rc.zoom));
    rc.tx = Math.min(0, Math.max(b.w - b.w * rc.zoom, rc.tx));
    rc.ty = Math.min(0, Math.max(b.h - b.h * rc.zoom, rc.ty));
    canvas().style.transform = `translate(${rc.tx}px, ${rc.ty}px) scale(${rc.zoom})`;
    $r('#rc-cursor').style.transform = `scale(${1 / rc.zoom})`;
    $r('#rc-zoom').classList.toggle('hidden', rc.zoom <= 1.01);
  }

  function updateCursor() {
    const c = $r('#rc-cursor');
    const show = rc.cursor && (rc.transport === 'jpeg' || rc.input === 'pad');
    c.classList.toggle('hidden', !show);
    if (!rc.cursor) return;
    c.classList.toggle('ring', rc.transport === 'rtc');
    const [x, y] = rc.cursor;
    c.style.left = (x * 100) + '%';
    c.style.top = (y * 100) + '%';
    // Тачпад при увеличении: вид следует за курсором
    if (rc.input === 'pad' && rc.zoom > 1.01) {
      const b = rc.base;
      const m = Math.min(60, b.w / 6);
      const px = x * b.w * rc.zoom + rc.tx;
      const py = y * b.h * rc.zoom + rc.ty;
      if (px < m) rc.tx += m - px; else if (px > b.w - m) rc.tx -= px - (b.w - m);
      if (py < m) rc.ty += m - py; else if (py > b.h - m) rc.ty -= py - (b.h - m);
      applyTransform();
    }
  }

  /** Точка экрана телефона → координаты на экране ПК (0..1). */
  function norm(cx, cy) {
    const r = canvas().getBoundingClientRect();
    if (!r.width) return null;
    const x = (cx - r.left) / r.width;
    const y = (cy - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function pinchTo(two, a, b) {
    const st = stage().getBoundingClientRect();
    const mid = { x: (a.x + b.x) / 2 - st.left - rc.base.x, y: (a.y + b.y) / 2 - st.top - rc.base.y };
    const z = Math.max(1, Math.min(5, two.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / two.dist)));
    const cx = (two.mid.x - two.tx) / two.zoom;
    const cy = (two.mid.y - two.ty) / two.zoom;
    rc.zoom = z;
    rc.tx = mid.x - cx * z;
    rc.ty = mid.y - cy * z;
    applyTransform();
  }

  // ---------------- жесты ----------------
  const pointers = new Map();
  let g = null;    // жест одним пальцем
  let two = null;  // жест двумя пальцами
  let lastTap = null;
  let lastMoveSent = 0;

  function wheelAcc(o, dx, dy) {
    o.acc += dy; o.accX += dx;
    const step = 30;
    if (Math.abs(o.acc) >= step) {
      const n = Math.trunc(o.acc / step);
      o.acc -= n * step;
      send({ type: 'wheel', dy: n * 120 });
    }
    if (Math.abs(o.accX) >= step * 1.5) {
      const n = Math.trunc(o.accX / (step * 1.5));
      o.accX -= n * step * 1.5;
      send({ type: 'wheel', dx: -n * 120, dy: 0 });
    }
  }

  function onDown(e) {
    e.preventDefault();
    try { stage().setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    if (pointers.size === 1) {
      g = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, lt: now, moved: false, long: false, dragging: false, acc: 0, accX: 0, multi: false };
      g.timer = setTimeout(onLong, rc.input === 'pad' ? 420 : 550);
    } else if (pointers.size === 2) {
      if (g) {
        clearTimeout(g.timer);
        g.multi = true;
        if (g.dragging) { send({ type: 'up' }); g.dragging = false; }
      }
      const [a, b] = [...pointers.values()];
      const st = stage().getBoundingClientRect();
      const midC = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      two = {
        t0: now, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: rc.zoom, tx: rc.tx, ty: rc.ty,
        mid: { x: midC.x - st.left - rc.base.x, y: midC.y - st.top - rc.base.y }, mid0: midC, last: midC,
        mode: null, acc: 0, accX: 0, moved: 0, done: false,
      };
    }
  }

  function onLong() {
    if (!g || g.moved || g.multi) return;
    g.long = true;
    haptic(25);
    if (rc.input === 'pad') {
      // Тачпад: удержание «зажимает» левую кнопку — дальше палец перетаскивает
      send({ type: 'down' });
      g.dragging = true;
      showHint('Перетаскивание', 900);
      return;
    }
    const p = norm(g.sx, g.sy);
    if (p) send({ type: 'click', button: 'right', ...p });
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && two) {
      const [a, b] = [...pointers.values()];
      const midC = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / two.dist;
      two.moved = Math.max(two.moved, Math.hypot(midC.x - two.mid0.x, midC.y - two.mid0.y), Math.abs(ratio - 1) * two.dist);
      if (rc.input === 'touch') {
        pinchTo(two, a, b);
      } else {
        if (!two.mode) {
          if (Math.abs(ratio - 1) > 0.15) two.mode = 'zoom';
          else if (Math.hypot(midC.x - two.mid0.x, midC.y - two.mid0.y) > 10) two.mode = 'scroll';
        }
        if (two.mode === 'zoom') pinchTo(two, a, b);
        else if (two.mode === 'scroll') wheelAcc(two, midC.x - two.last.x, midC.y - two.last.y);
      }
      two.last = midC;
      return;
    }
    if (!g || g.multi) return;
    const dx = e.clientX - g.lx;
    const dy = e.clientY - g.ly;
    const now = performance.now();
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > (rc.input === 'pad' ? 5 : 9)) {
      g.moved = true;
      if (!g.dragging) clearTimeout(g.timer);
    }
    if (!g.moved) return;
    if (rc.input === 'pad') {
      // Курсор с ускорением: медленно — точно, быстро — далеко
      const speed = Math.hypot(dx, dy) / Math.max(1, now - g.lt);
      const accel = Math.min(3.2, 1 + speed * 1.2);
      const d = rc.displays.find((x) => x.index === rc.monitor);
      const k = SENS[rc.sens] * accel * Math.max(0.6, ((d && d.width) || 1920) / 1920) / Math.max(1, rc.zoom * 0.7);
      relMove(dx * k, dy * k);
    } else if (rc.zoom > 1.01 && !rc.dragMode) {
      rc.tx += dx; rc.ty += dy; applyTransform();
    } else if (rc.dragMode) {
      if (!g.dragging) {
        const p0 = norm(g.sx, g.sy);
        if (p0) { send({ type: 'down', ...p0 }); g.dragging = true; }
      }
      if (g.dragging && (dcOpen() || now - lastMoveSent > 50)) {
        const p = norm(e.clientX, e.clientY);
        if (p) { send({ type: 'move', ...p }); lastMoveSent = now; }
      }
    } else {
      wheelAcc(g, dx, dy);
    }
    g.lx = e.clientX; g.ly = e.clientY; g.lt = now;
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.delete(e.pointerId);
    if (two && pointers.size < 2 && !two.done) {
      two.done = true;
      // Короткое нажатие двумя пальцами — правый клик
      if (performance.now() - two.t0 < 320 && two.moved < 14 && !two.mode) {
        haptic(15);
        if (rc.input === 'pad') send({ type: 'click', button: 'right' });
        else {
          const p = norm(two.mid0.x, two.mid0.y);
          if (p) send({ type: 'click', button: 'right', ...p });
        }
      }
    }
    if (pointers.size > 0) return;
    two = null;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.dragging) {
      flushRel();
      const p = rc.input === 'touch' ? norm(e.clientX, e.clientY) : null;
      send({ type: 'up', ...(p || {}) });
    } else if (!g.moved && !g.long && !g.multi) {
      tap();
    }
    g = null;
  }

  function tap() {
    const button = rc.rightNext ? 'right' : 'left';
    if (rc.rightNext) { rc.rightNext = false; $r('#rc-right').classList.remove('active'); }
    haptic(6);
    if (rc.input === 'pad') {
      send({ type: 'click', button });
      flashTap(g.sx, g.sy);
      return;
    }
    let p = norm(g.sx, g.sy);
    if (!p) return;
    const now = performance.now();
    // Второе нажатие рядом с первым — в ту же точку, чтобы Windows засчитала двойной клик
    if (lastTap && now - lastTap.t < 400 && Math.hypot(g.sx - lastTap.cx, g.sy - lastTap.cy) < 30) p = lastTap.p;
    send({ type: 'click', button, ...p });
    lastTap = { t: now, cx: g.sx, cy: g.sy, p };
    flashTap(g.sx, g.sy);
  }

  function flashTap(cx, cy) {
    const st = stage().getBoundingClientRect();
    const dot = document.createElement('div');
    dot.className = 'rc-tap';
    dot.style.left = (cx - st.left) + 'px';
    dot.style.top = (cy - st.top) + 'px';
    stage().append(dot);
    setTimeout(() => dot.remove(), 450);
  }

  // ---------------- клавиатура ----------------
  const NAMED = {
    Enter: 'enter', Tab: 'tab', Escape: 'esc', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
    PageUp: 'pgup', PageDown: 'pgdn', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  };
  for (let i = 1; i <= 12; i++) NAMED['F' + i] = 'f' + i;

  function clearMods() {
    rc.mods.clear();
    document.querySelectorAll('[data-mod]').forEach((b) => b.classList.remove('active'));
    updateModsRow();
  }

  function updateModsRow() {
    const kbOpen = document.activeElement === $r('#rc-kbd');
    $r('#rc-mods').classList.toggle('hidden', !kbOpen && !rc.mods.size);
    $r('#rc-kb').classList.toggle('active', kbOpen);
    requestAnimationFrame(() => layout(false));
  }

  let prevText = '';
  function bindKeyboard() {
    const kbd = $r('#rc-kbd');
    kbd.addEventListener('input', () => {
      const v = kbd.value;
      let cp = 0;
      while (cp < v.length && cp < prevText.length && v[cp] === prevText[cp]) cp++;
      const removed = prevText.length - cp;
      for (let i = 0; i < removed; i++) send({ type: 'key', keys: 'backspace' });
      const added = v.slice(cp);
      if (added && rc.mods.size) {
        // Ctrl/Alt/Win + буква → сочетание клавиш (Ctrl+C и т. п.)
        const mods = MOD_ORDER.filter((m) => rc.mods.has(m));
        for (const ch of added) {
          const k = ch === ' ' ? 'space' : ch.toLowerCase();
          if (/^[a-z0-9]$/.test(k) || k === 'space') send({ type: 'key', keys: [...mods, k].join('+') });
          else send({ type: 'text', text: ch });
        }
        clearMods();
      } else if (added) send({ type: 'text', text: added });
      prevText = v;
      if (v.length > 300) { kbd.value = ''; prevText = ''; }
    });
    kbd.addEventListener('keydown', (e) => {
      const mods = [];
      if (e.ctrlKey) mods.push('ctrl');
      if (e.altKey) mods.push('alt');
      if (e.metaKey) mods.push('win');
      if (e.key === 'Backspace') {
        if (!kbd.value || mods.length) { e.preventDefault(); key([...mods, 'backspace'].join('+')); }
        return;
      }
      const named = NAMED[e.key];
      if (named) {
        e.preventDefault();
        if (e.shiftKey) mods.push('shift');
        key([...mods, named].join('+'));
      } else if (mods.length && e.key.length === 1 && /^[a-z0-9]$/i.test(e.key)) {
        e.preventDefault();
        if (e.shiftKey) mods.push('shift');
        key([...mods, e.key.toLowerCase()].join('+'));
      }
    });
    kbd.addEventListener('focus', updateModsRow);
    kbd.addEventListener('blur', () => setTimeout(updateModsRow, 50));
  }

  // Клавиатура телефона не должна закрывать панель управления: подгоняем окно под видимую область
  function fitViewport() {
    const r = $r('#remote');
    const vv = window.visualViewport;
    if (!vv || !rc.open) { r.style.height = ''; r.style.top = ''; return; }
    r.style.height = vv.height + 'px';
    r.style.top = vv.offsetTop + 'px';
    layout(false);
  }

  /**
   * Кнопка, которая срабатывает по касанию, не забирая фокус у клавиатуры
   * (иначе на iPhone клавиатура закрывается при каждом нажатии Ctrl, стрелок и т. п.).
   */
  function tapButton(btn, fn) {
    let start = null;
    btn.addEventListener('touchstart', (e) => { const t = e.touches[0]; start = { x: t.clientX, y: t.clientY }; }, { passive: true });
    btn.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      if (!start || Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) return; // это была прокрутка панели
      e.preventDefault();
      fn(e);
    }, { passive: false });
    btn.addEventListener('click', fn);
  }

  // ---------------- настройки ----------------
  function seg(options, current, onPick) {
    const box = el('div', { class: 'rc-seg' });
    for (const [v, label] of options) {
      box.append(el('button', {
        class: v === current ? 'active' : '', text: label,
        onclick: (e) => { box.querySelectorAll('button').forEach((b) => b.classList.remove('active')); e.currentTarget.classList.add('active'); onPick(v); },
      }));
    }
    return box;
  }

  function settingsSheet() {
    const h = rc.host || {};
    const v = rc.view || {};
    const rows = [];
    const row = (k, val) => rows.push(el('div', { class: 'rc-info-row' }, el('span', { text: k }), el('b', { text: val })));
    row('Соединение', rc.transport === 'rtc' ? 'видео напрямую (WebRTC)' : rc.transport === 'ws' ? 'видео через защищённый туннель' : 'совместимость (кадры)');
    if (v.fps != null) row('Кадров в секунду', `${v.fps}${h.target ? ` из ${h.target}` : ''}`);
    if (v.w) row('Разрешение', `${v.w}×${v.h}`);
    if (h.codec) row('Кодек', `${h.codec}${h.hw ? ' · аппаратный' : h.encoder ? ` · ${h.encoder}` : ''}`);
    if (h.kbps) row('Поток', `${(h.kbps / 1000).toFixed(1)} Мбит/с`);
    if (v.ping != null) row('Задержка сети', `${v.ping} мс`);
    if (h.limit && h.limit !== 'none') row('Ограничение', h.limit === 'cpu' ? 'процессор ПК не успевает' : h.limit === 'bandwidth' ? 'скорость Wi-Fi' : h.limit);

    const presets = el('div', { class: 'rc-opts' }, rc.presets.map((p) => el('button', {
      class: 'rc-opt' + (p.id === rc.preset ? ' active' : ''),
      onclick: () => { setPreset(p.id); closeSheet(); },
    }, el('b', { text: p.name }), el('small', { text: p.desc }))));

    openSheet('Удалённое управление', [
      el('div', { class: 'section-title', text: 'Качество картинки' }),
      presets,
      el('div', { class: 'section-title', text: 'Управление' }),
      seg([['touch', 'Касание'], ['pad', 'Тачпад']], rc.input, (x) => setInput(x)),
      el('p', { class: 'rc-help', text: rc.input === 'pad' ? HELP.pad : HELP.touch }),
      el('div', { class: 'section-title', text: 'Скорость курсора (тачпад)' }),
      seg([['slow', 'Медленно'], ['normal', 'Обычно'], ['fast', 'Быстро']], rc.sens, (x) => { rc.sens = x; setPref('sens', x); }),
      el('div', { class: 'section-title', text: 'Соединение' }),
      el('div', { class: 'rc-info' }, rows),
    ]);
  }

  const HELP = {
    touch: 'Нажатие — клик, двойное — двойной клик, удержание или нажатие двумя пальцами — правый клик. Палец — прокрутка (или перетаскивание, кнопка «Тянуть»), два пальца — увеличение.',
    pad: 'Палец двигает курсор, как тачпад ноутбука. Нажатие — клик, нажатие двумя пальцами — правый клик, два пальца — прокрутка, удержание и движение — перетаскивание, разведение пальцев — увеличение.',
  };

  function setPreset(id) {
    rc.preset = id;
    setPref('preset', id);
    const p = presetById(id);
    if (rc.transport === 'rtc') dcSend({ type: 'preset', name: id });
    showHint(`Качество: ${p.name}`, 1800);
  }

  function setInput(mode, quiet) {
    rc.input = mode === 'pad' ? 'pad' : 'touch';
    setPref('input', rc.input);
    const btn = $r('#rc-input');
    btn.replaceChildren(ic(rc.input === 'pad' ? 'trackpad' : 'touch', 20), el('span', { text: rc.input === 'pad' ? 'Тачпад' : 'Касание' }));
    $r('#rc-mode').classList.toggle('hidden', rc.input === 'pad');
    if (rc.dragMode && rc.input === 'pad') { rc.dragMode = false; $r('#rc-mode').classList.remove('active'); $r('#rc-mode-label').textContent = 'Листать'; }
    updateCursor();
    if (!quiet) showHint(rc.input === 'pad' ? 'Тачпад: палец двигает курсор, нажатие — клик' : 'Касание: нажмите туда, куда нужно кликнуть', 2500);
  }

  function setFull(on) {
    rc.full = on;
    $r('#remote').classList.toggle('full', on);
    $r('#rc-restore').classList.toggle('hidden', !on);
    const root = document.documentElement;
    try {
      if (on && root.requestFullscreen && !document.fullscreenElement) root.requestFullscreen().catch(() => {});
      if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } catch (e) { /* iPhone: только скрываем панели */ }
    setTimeout(() => layout(true), 120);
  }

  // ---------------- открыть / закрыть ----------------
  async function open(opts = {}) {
    let info;
    try { info = await api('/api/remote/info'); } catch (e) { toast(e.message, 'err'); return; }
    if (!info.enabled) { toast('Удалённое управление выключено в программе на ПК (Настройки → Приложение на телефоне)', 'err'); return; }
    rc.displays = info.displays || [];
    rc.presets = info.presets && info.presets.length ? info.presets : FALLBACK_PRESETS;
    if (!rc.presets.some((p) => p.id === rc.preset)) rc.preset = 'auto';
    if (!rc.displays.some((d) => d.index === rc.monitor)) rc.monitor = (rc.displays.find((d) => d.primary) || rc.displays[0] || { index: 1 }).index;
    const gen = ++rc.gen;
    rc.open = true;
    rc.view = {};
    rc.host = {};
    rc.cursor = null;
    $r('#remote').classList.remove('hidden');
    document.body.classList.add('rc-open');
    $r('#rc-monitor').classList.toggle('hidden', rc.displays.length < 2);
    $r('#rc-monitor-num').textContent = String(rc.monitor);
    $r('#rc-error').classList.add('hidden');
    setInput(rc.input, true);
    setStatus('подключение…', 'wait');
    fitViewport();
    try { rc.wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { rc.wakeLock = null; }

    let ok = false;
    const far = !!info.viaInternet;
    // Через интернет: если прямое соединение уже не получалось — сразу поток через туннель
    const preferWs = opts.force === 'ws' || (far && pref('far_mode', '') === 'ws' && opts.force !== 'rtc');
    if (!preferWs && info.rtc && window.RTCPeerConnection && opts.force !== 'jpeg') {
      rc.transport = 'rtc';
      showMedia();
      try { ok = await connectRtc(gen); } catch (e) { ok = false; }
      if (!ok && gen === rc.gen) cleanupRtc();
      if (far) setPref('far_mode', ok ? 'rtc' : 'ws');
    }
    if (!ok && gen === rc.gen && canWs() && opts.force !== 'jpeg' && opts.force !== 'rtc') {
      rc.transport = 'ws';
      showMedia();
      try { ok = await connectWs(gen); } catch (e) { ok = false; }
      if (!ok && gen === rc.gen) cleanupWs();
      if (ok) {
        setStatus('подключено', 'on');
        wsStatsLoop(gen);
        if (innerHeight > innerWidth && !rc.rotateHinted) { rc.rotateHinted = true; showHint('Поверните телефон — экран ПК станет крупнее', 3500); }
        return;
      }
    }
    if (gen !== rc.gen) return;
    if (ok) {
      setStatus('подключено', 'on');
      statsLoop(gen);
      if (innerHeight > innerWidth && !rc.rotateHinted) { rc.rotateHinted = true; showHint('Поверните телефон — экран ПК станет крупнее', 3500); }
      return;
    }
    startJpeg(gen);
    if (info.rtc) showHint('Видео не подключилось — включён режим совместимости', 4000);
  }

  function close() {
    rc.open = false;
    rc.gen++;
    if (rc.transport === 'rtc') cleanupRtc();
    if (rc.transport === 'ws') cleanupWs();
    rc.transport = null;
    if (rc.full) setFull(false);
    clearMods();
    $r('#remote').classList.add('hidden');
    document.body.classList.remove('rc-open');
    $r('#rc-kbd').blur();
    fitViewport();
    if (rc.wakeLock) { rc.wakeLock.release().catch(() => {}); rc.wakeLock = null; }
  }

  function moreKeys() {
    const groups = [
      ['Правка', [['Ctrl+C', 'ctrl+c'], ['Ctrl+V', 'ctrl+v'], ['Ctrl+X', 'ctrl+x'], ['Ctrl+Z', 'ctrl+z'], ['Ctrl+A', 'ctrl+a'], ['Ctrl+S', 'ctrl+s']]],
      ['Окна', [['Alt+F4', 'alt+f4'], ['Win+D', 'win+d'], ['Win+E', 'win+e'], ['Win+Tab', 'win+tab'], ['Диспетчер задач', 'ctrl+shift+esc'], ['Win+L', 'win+l']]],
      ['Браузер', [['Новая вкладка', 'ctrl+t'], ['Закрыть вкладку', 'ctrl+w'], ['Обновить', 'f5'], ['Назад', 'alt+left'], ['Вперёд', 'alt+right'], ['Во весь экран', 'f11']]],
      ['Клавиши', [['Tab', 'tab'], ['Shift+Tab', 'shift+tab'], ['Delete', 'delete'], ['Home', 'home'], ['End', 'end'], ['PgUp', 'pgup'], ['PgDn', 'pgdn'], ['PrtSc', 'printscreen'], ['Пробел', 'space']]],
      ['Звук', [['Тише', 'voldown'], ['Громче', 'volup'], ['Без звука', 'mute']]],
    ];
    const body = groups.map(([title, keys]) => [
      el('div', { class: 'section-title', text: title }),
      el('div', { class: 'rc-keys' }, keys.map(([label, k]) => el('button', { class: 'rc-key', text: label, onclick: () => key(k) }))),
    ]).flat();
    openSheet('Клавиши', body);
  }

  function init() {
    const st = stage();
    st.addEventListener('pointerdown', onDown, { passive: false });
    st.addEventListener('pointermove', onMove, { passive: false });
    st.addEventListener('pointerup', onUp, { passive: false });
    st.addEventListener('pointercancel', onUp, { passive: false });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    // Колесо мыши и тачпад (планшет, ПК) — прокрутка
    st.addEventListener('wheel', (e) => { e.preventDefault(); send({ type: 'wheel', dy: -Math.sign(e.deltaY) * 120 }); }, { passive: false });
    window.addEventListener('resize', () => { if (rc.open) layout(true); });
    if (window.visualViewport) {
      visualViewport.addEventListener('resize', fitViewport);
      visualViewport.addEventListener('scroll', fitViewport);
    }
    video().addEventListener('resize', () => layout(false));
    video().addEventListener('loadedmetadata', () => layout(true));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !rc.open) return;
      if (rc.transport === 'ws') { if (!wsOpen()) reconnect(rc.gen); return; }
      if (rc.transport !== 'rtc') return;
      const pc = rc.pc;
      if (!pc || ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) reconnect(rc.gen);
      else video().play().catch(() => {});
    });
    bindKeyboard();

    $r('#rc-close').addEventListener('click', close);
    tapButton($r('#rc-kb'), () => {
      const kbd = $r('#rc-kbd');
      if (document.activeElement === kbd) kbd.blur(); else { kbd.value = ''; prevText = ''; kbd.focus(); }
    });
    tapButton($r('#rc-input'), () => setInput(rc.input === 'pad' ? 'touch' : 'pad'));
    tapButton($r('#rc-mode'), () => {
      rc.dragMode = !rc.dragMode;
      $r('#rc-mode').classList.toggle('active', rc.dragMode);
      $r('#rc-mode-label').textContent = rc.dragMode ? 'Тянуть' : 'Листать';
      showHint(rc.dragMode ? 'Палец перетаскивает (выделение, перенос окон)' : 'Палец прокручивает', 2000);
    });
    tapButton($r('#rc-right'), () => {
      rc.rightNext = !rc.rightNext;
      $r('#rc-right').classList.toggle('active', rc.rightNext);
    });
    $r('#rc-zoom').addEventListener('click', () => { rc.zoom = 1; rc.tx = 0; rc.ty = 0; applyTransform(); });
    $r('#rc-settings').addEventListener('click', settingsSheet);
    $r('#rc-status').addEventListener('click', settingsSheet);
    $r('#rc-full').addEventListener('click', () => setFull(true));
    $r('#rc-restore').addEventListener('click', () => setFull(false));
    $r('#rc-sound').addEventListener('click', () => {
      const v = video();
      v.muted = !v.muted;
      v.play().catch(() => {});
      updateSound();
    });
    $r('#rc-monitor').addEventListener('click', () => {
      const i = rc.displays.findIndex((d) => d.index === rc.monitor);
      rc.monitor = rc.displays[(i + 1) % rc.displays.length].index;
      $r('#rc-monitor-num').textContent = String(rc.monitor);
      if (rc.transport === 'rtc') dcSend({ type: 'monitor', index: rc.monitor });
      layout(true);
    });
    document.querySelectorAll('#remote [data-rckey]').forEach((b) => tapButton(b, () => key(b.dataset.rckey)));
    document.querySelectorAll('#remote [data-mod]').forEach((b) => tapButton(b, () => {
      const m = b.dataset.mod;
      if (rc.mods.has(m)) rc.mods.delete(m); else rc.mods.add(m);
      b.classList.toggle('active', rc.mods.has(m));
      haptic(6);
      updateModsRow();
    }));
    tapButton($r('#rc-more'), moreKeys);
    document.querySelectorAll('[data-open-remote]').forEach((b) => b.addEventListener('click', open));
  }

  // Для автоматических проверок
  const state = () => ({ open: rc.open, transport: rc.transport, view: rc.view, host: rc.host, preset: rc.preset, input: rc.input, cursor: rc.cursor, frames: rc.wsFrames || 0 });
  window.RemoteControl = { open, close, state, send, setPreset, setInput };
  init();
})();
