'use strict';
// Скрытое окно трансляции: захват экрана, кодирование (WebRTC) и канал управления с телефоном.
(() => {
  const host = window.host;
  const S = new Map(); // sid -> сеанс
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const log = (...a) => host.log(a.join(' '));

  function size(source, p) {
    const k = Math.min(1, p.maxWidth / source.width);
    return { w: even(source.width * k), h: even(source.height * k) };
  }

  async function captureVideo(source, p) {
    const { w, h } = size(source, p);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxWidth: w, maxHeight: h, maxFrameRate: p.fps } },
      });
    } catch (e) {
      throw new Error('Не удалось захватить экран: ' + (e.message || e.name));
    }
    const track = stream.getVideoTracks()[0];
    track.contentHint = p.hint;
    return { stream, track };
  }

  // Звук ПК (Windows): захват всего системного звука
  async function captureAudio() {
    const st = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 320, maxHeight: 240, maxFrameRate: 1 } },
    });
    st.getVideoTracks().forEach((t) => t.stop());
    return st.getAudioTracks()[0] || null;
  }

  function send(s, msg) {
    if (s && s.dc && s.dc.readyState === 'open') {
      try { s.dc.send(JSON.stringify(msg)); } catch (e) { /* канал закрывается */ }
    }
  }

  async function setParams(s) {
    const p = s.preset;
    const params = s.sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    const enc = params.encodings[0];
    enc.maxBitrate = p.bitrate * 1000;
    enc.maxFramerate = p.fps;
    enc.priority = 'high';
    enc.networkPriority = 'high';
    params.degradationPreference = p.degradation;
    try {
      await s.sender.setParameters(params);
    } catch (e) {
      delete params.degradationPreference;
      try { await s.sender.setParameters(params); } catch (e2) { log('setParameters', e2.message); }
    }
  }

  async function applyPreset(s, name) {
    const p = s.presets[name];
    if (!p) return;
    s.presetName = name;
    s.preset = p;
    const { w, h } = size(s.source, p);
    try { await s.track.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: p.fps } }); } catch (e) { log('applyConstraints', e.message); }
    s.track.contentHint = p.hint;
    await setParams(s);
    send(s, { type: 'preset', name });
  }

  async function switchMonitor(s, index) {
    const source = await host.source(index);
    const { stream, track } = await captureVideo(source, s.preset);
    await s.sender.replaceTrack(track);
    s.track.stop();
    s.stream.getVideoTracks().forEach((t) => t.stop());
    s.track = track;
    s.stream = stream;
    s.source = source;
    host.monitor(s.sid, source.index);
    send(s, { type: 'monitor', index: source.index, width: source.width, height: source.height });
  }

  async function stats(s) {
    if (!s.sender) return;
    const r = await s.sender.getStats();
    let out = null;
    r.forEach((x) => { if (x.type === 'outbound-rtp' && x.kind === 'video') out = x; });
    if (!out) return;
    const codec = out.codecId && r.get(out.codecId) ? r.get(out.codecId).mimeType.replace(/^video\//i, '') : '';
    const now = performance.now();
    const kbps = s.lastBytes != null ? Math.round(((out.bytesSent - s.lastBytes) * 8) / (now - s.lastT)) : 0;
    s.lastBytes = out.bytesSent;
    s.lastT = now;
    send(s, {
      type: 'stats', fps: Math.round(out.framesPerSecond || 0), w: out.frameWidth || 0, h: out.frameHeight || 0, codec, kbps,
      encoder: out.encoderImplementation || '', hw: !!out.powerEfficientEncoder, limit: out.qualityLimitationReason || 'none',
      target: s.preset.fps,
    });
  }

  function onMessage(s, data) {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    switch (m.type) {
      case 'input': host.input(s.sid, m.cmd); break;
      case 'preset': applyPreset(s, m.name).catch((e) => send(s, { type: 'error', message: e.message })); break;
      case 'monitor': switchMonitor(s, m.index).catch((e) => send(s, { type: 'error', message: e.message })); break;
      case 'ping': send(s, { type: 'pong', t: m.t }); break;
      case 'bye': stop(s.sid); break;
      default: break;
    }
  }

  function gathered(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  async function start({ sid, source, preset, presets, audio, iceServers = [] }) {
    const p = presets[preset];
    const { stream, track } = await captureVideo(source, p);
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const s = { sid, pc, stream, track, source, presets, preset: p, presetName: preset, dc: null, timer: null, audioTrack: null };
    S.set(sid, s);
    try {
      const tr = pc.addTransceiver(track, {
        direction: 'sendonly', streams: [stream],
        sendEncodings: [{ maxBitrate: p.bitrate * 1000, maxFramerate: p.fps, priority: 'high', networkPriority: 'high' }],
      });
      s.sender = tr.sender;
      try {
        const caps = RTCRtpSender.getCapabilities('video');
        if (caps && tr.setCodecPreferences) tr.setCodecPreferences(window.Sdp.sortCodecs(caps.codecs));
      } catch (e) { log('codecs', e.message); }
      if (audio) {
        try {
          s.audioTrack = await captureAudio();
          if (s.audioTrack) pc.addTransceiver(s.audioTrack, { direction: 'sendonly', streams: [stream] });
        } catch (e) { log('audio', e.message); }
      }
      s.dc = pc.createDataChannel('ctl', { ordered: true });
      s.dc.onmessage = (e) => onMessage(s, e.data);
      s.dc.onopen = () => send(s, { type: 'hello', preset: s.presetName, monitor: source.index, audio: !!s.audioTrack });
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'connected') {
          clearTimeout(s.disc);
          clearTimeout(s.noAnswer);
          if (!s.timer) s.timer = setInterval(() => stats(s).catch(() => {}), 1000);
        } else if (st === 'disconnected') {
          clearTimeout(s.disc);
          s.disc = setTimeout(() => stop(sid), 10000);
        } else if (st === 'failed' || st === 'closed') stop(sid);
      };
      s.noAnswer = setTimeout(() => stop(sid), 40000);
      await pc.setLocalDescription();
      await gathered(pc, 2500);
      return { sdp: pc.localDescription.sdp, audio: !!s.audioTrack };
    } catch (e) {
      stop(sid);
      throw e;
    }
  }

  async function answer({ sid, sdp }) {
    const s = S.get(sid);
    if (!s) throw new Error('Сеанс трансляции не найден');
    const b = s.preset.bitrate;
    await s.pc.setRemoteDescription({ type: 'answer', sdp: window.Sdp.tune(sdp, { start: Math.min(b * 0.6, 15000), min: Math.min(1500, b / 2), max: b }) });
    await setParams(s);
    return { ok: true };
  }


  // ---------------- поток H.264 по WebSocket (WebCodecs) ----------------
  // Для интернета: кодируем сами (видеокарта, если есть) и отдаём кадры главному процессу.
  const CODECS = ['avc1.640033', 'avc1.4D0033', 'avc1.42E033', 'avc1.42001F'];

  async function pickCodec(w, h, fps, bitrate) {
    for (const codec of CODECS) {
      for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
        const cfg = { codec, width: w, height: h, framerate: fps, bitrate, hardwareAcceleration, latencyMode: 'realtime', bitrateMode: 'variable', avc: { format: 'annexb' } };
        try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (e) { /* следующий */ }
      }
    }
    throw new Error('Кодировщик H.264 недоступен на этом компьютере');
  }

  function encSize(source, p) {
    const k = Math.min(1, (p.wsMaxWidth || 1920) / source.width);
    return { w: even(source.width * k), h: even(source.height * k) };
  }

  async function configureEnc(s) {
    const p = s.preset;
    const bitrate = Math.round((p.wsBitrate || 8000) * 1000 * (s.scale || 1));
    const cfg = await pickCodec(s.w, s.h, Math.min(p.fps, 60), bitrate);
    if (s.encoder && s.encoder.state !== 'closed') { try { s.encoder.close(); } catch (e) { /* ignore */ } }
    s.encoder = new VideoEncoder({
      output: (chunk) => {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        s.bytes += chunk.byteLength;
        s.outFrames++;
        host.chunk(s.sid, { key: chunk.type === 'key', ts: chunk.timestamp, w: s.w, h: s.h }, buf);
      },
      error: (e) => { log('encoder', e.message); s.encoder = null; },
    });
    s.encoder.configure(cfg);
    s.cfg = cfg;
    s.needKey = true;
    host.wsinfo(s.sid, { type: 'config', codec: cfg.codec, width: s.w, height: s.h, hw: cfg.hardwareAcceleration === 'prefer-hardware', fps: cfg.framerate, kbps: Math.round(bitrate / 1000) });
  }

  async function startEnc({ sid, source, preset, presets }) {
    const p = presets[preset];
    const { w, h } = encSize(source, p);
    const capP = { ...p, maxWidth: p.wsMaxWidth || 1920, fps: Math.min(p.fps, 60) };
    const { stream, track } = await captureVideo(source, capP);
    const s = { sid, kind: 'ws', stream, track, source, presets, preset: p, presetName: preset, w, h, scale: 1, needKey: true, frames: 0, outFrames: 0, bytes: 0, encoder: null };
    S.set(sid, s);
    try { await configureEnc(s); } catch (e) { stopEnc(sid); throw e; }
    const proc = new MediaStreamTrackProcessor({ track });
    s.reader = proc.readable.getReader();
    // Статистика раз в секунду
    let lastBytes = 0;
    let lastFrames = 0;
    s.timer = setInterval(() => {
      host.wsinfo(sid, { type: 'stats', fps: s.outFrames - lastFrames, kbps: Math.round(((s.bytes - lastBytes) * 8) / 1000), w: s.w, h: s.h, codec: s.cfg ? s.cfg.codec : '', hw: !!(s.cfg && s.cfg.hardwareAcceleration === 'prefer-hardware'), scale: s.scale, target: s.cfg ? s.cfg.framerate : 0 });
      lastBytes = s.bytes;
      lastFrames = s.outFrames;
    }, 1000);
    (async () => {
      const keyEvery = Math.max(60, (s.cfg.framerate || 30) * 5);
      while (S.get(sid) === s) {
        let r;
        const rd = s.reader;
        try { r = await rd.read(); } catch (e) { if (s.reader !== rd && S.get(sid) === s) continue; break; }
        // Смена монитора подменяет источник кадров — продолжаем уже с новым
        if (r.done) { if (s.reader !== rd && S.get(sid) === s) continue; break; }
        const frame = r.value;
        try {
          const ok = s.encoder && s.encoder.state === 'configured';
          // Кодировщик не успевает — пропускаем кадр, чтобы не копить задержку
          if (!ok || s.encoder.encodeQueueSize > 2) continue;
          let src = frame;
          if (frame.displayWidth !== s.w || frame.displayHeight !== s.h) {
            // Размер экрана изменился — подстраиваем кодировщик
            s.w = even(frame.displayWidth); s.h = even(frame.displayHeight);
            await configureEnc(s);
            src = frame;
          }
          const key = s.needKey || s.frames % keyEvery === 0;
          s.needKey = false;
          s.encoder.encode(src, { keyFrame: key });
          s.frames++;
        } catch (e) {
          log('encode', e.message);
        } finally {
          frame.close();
        }
      }
    })();
    return { ok: true, w, h };
  }

  function stopEnc(sid) {
    const s = S.get(sid);
    if (!s) return;
    S.delete(sid);
    clearInterval(s.timer);
    try { if (s.reader) s.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (s.encoder && s.encoder.state !== 'closed') s.encoder.close(); } catch (e) { /* ignore */ }
    try { s.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    host.closed(sid);
  }

  let rateBusy = false;
  async function wsRate(sid, scale) {
    const s = S.get(sid);
    if (!s || s.kind !== 'ws' || rateBusy) return;
    rateBusy = true;
    try { s.scale = scale; await configureEnc(s); } catch (e) { log('rate', e.message); } finally { rateBusy = false; }
  }

  async function wsPreset(sid, name) {
    const s = S.get(sid);
    if (!s || !s.presets[name]) return;
    const p = s.presets[name];
    s.preset = p;
    s.presetName = name;
    const { w, h } = encSize(s.source, p);
    try { await s.track.applyConstraints({ width: { max: w }, height: { max: h }, frameRate: { max: Math.min(p.fps, 60) } }); } catch (e) { log('applyConstraints', e.message); }
    s.scale = 1;
    host.wsinfo(sid, { type: 'preset', name });
  }

  async function wsMonitor(sid, index) {
    const s = S.get(sid);
    if (!s) return;
    const source = await host.source(index);
    const { stream, track } = await captureVideo(source, { ...s.preset, maxWidth: s.preset.wsMaxWidth || 1920, fps: Math.min(s.preset.fps, 60) });
    try { s.reader.cancel(); } catch (e) { /* ignore */ }
    s.stream.getTracks().forEach((t) => t.stop());
    s.stream = stream; s.track = track; s.source = source;
    const sz = encSize(source, s.preset);
    s.w = sz.w; s.h = sz.h;
    await configureEnc(s);
    s.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    host.monitor(sid, source.index);
    host.wsinfo(sid, { type: 'monitor', index: source.index, width: source.width, height: source.height });
  }

  function stop(sid) {
    const s = S.get(sid);
    if (!s) return;
    if (s.kind === 'ws') { stopEnc(sid); return; }
    S.delete(sid);
    clearInterval(s.timer);
    clearTimeout(s.disc);
    clearTimeout(s.noAnswer);
    try { s.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { if (s.audioTrack) s.audioTrack.stop(); } catch (e) { /* ignore */ }
    try { s.pc.close(); } catch (e) { /* ignore */ }
    host.closed(sid);
  }

  host.onCommand(async (m) => {
    try {
      let data = null;
      switch (m.type) {
        case 'start': data = await start(m); break;
        case 'answer': data = await answer(m); break;
        case 'stop': stop(m.sid); return;
        case 'cursor':
          for (const [sid, c] of Object.entries(m.cursors || {})) send(S.get(sid), { type: 'cursor', p: c });
          return;
        case 'notify': { const x = S.get(m.sid); if (x && x.kind === 'ws') host.wsinfo(m.sid, { type: 'error', message: m.error }); else send(x, { type: 'error', message: m.error }); return; }
        case 'startEnc': data = await startEnc(m); break;
        case 'wsKey': { const x = S.get(m.sid); if (x) x.needKey = true; return; }
        case 'wsRate': wsRate(m.sid, m.scale); return;
        case 'wsPreset': wsPreset(m.sid, m.name); return;
        case 'wsMonitor': wsMonitor(m.sid, m.index).catch((e) => host.wsinfo(m.sid, { type: 'error', message: e.message })); return;
        default: return;
      }
      if (m.rid) host.reply(m.rid, true, data);
    } catch (e) {
      if (m.rid) host.reply(m.rid, false, null, e.message || String(e));
    }
  });
  host.ready();
})();
