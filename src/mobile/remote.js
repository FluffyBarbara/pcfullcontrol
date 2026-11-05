'use strict';
// Удалённое управление экраном ПК с телефона.
// Нажатие — клик, двойное нажатие — двойной клик, удержание — правый клик,
// палец — прокрутка (или перетаскивание), два пальца — масштаб. Клавиатура и горячие клавиши — внизу.
(() => {
  const QUALITY = [
    { name: 'Быстро', w: 960, q: 45 },
    { name: 'Норм', w: 1280, q: 60 },
    { name: 'Чётко', w: 1920, q: 75 },
  ];
  const rc = {
    open: false, monitor: 1, displays: [], quality: 1, dragMode: false, rightNext: false,
    zoom: 1, tx: 0, ty: 0, base: { x: 0, y: 0, w: 0, h: 0 }, prevUrl: null, frames: [], queue: Promise.resolve(),
    wakeLock: null,
  };
  const $r = (s) => document.querySelector(s);
  const stage = () => $r('#rc-stage');
  const canvas = () => $r('#rc-canvas');
  const img = () => $r('#rc-img');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- отправка команд ----------------
  function send(cmd) {
    const body = JSON.stringify({ ...cmd, monitor: rc.monitor });
    rc.queue = rc.queue.then(() => fetch('/api/remote/input', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body,
    }).then(async (r) => {
      if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error || 'Ошибка управления', 'err'); }
    }).catch(() => {}));
    return rc.queue;
  }
  const key = (keys) => { haptic(8); return send({ type: 'key', keys }); };

  // ---------------- кадры ----------------
  async function loop() {
    while (rc.open) {
      const t0 = performance.now();
      const Q = QUALITY[rc.quality];
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
        showCursor(cur);
        rc.frames.push(performance.now());
        rc.frames = rc.frames.filter((t) => performance.now() - t < 2000);
        $r('#rc-fps').textContent = `${(rc.frames.length / 2).toFixed(1)} кадр/с`;
        $r('#rc-dot').className = 'dot on';
        $r('#rc-error').classList.add('hidden');
      } catch (e) {
        $r('#rc-dot').className = 'dot off';
        const err = $r('#rc-error');
        err.textContent = e.message === 'Failed to fetch' ? 'Нет связи с компьютером' : e.message;
        err.classList.remove('hidden');
        await sleep(1500);
      }
      const dt = performance.now() - t0;
      if (dt < 70) await sleep(70 - dt);
      while (rc.open && document.hidden) await sleep(500);
    }
  }

  function showCursor(cur) {
    const c = $r('#rc-cursor');
    if (!cur) { c.classList.add('hidden'); return; }
    const [x, y] = cur.split(',').map(Number);
    c.classList.remove('hidden');
    c.style.left = (x * 100) + '%';
    c.style.top = (y * 100) + '%';
  }

  // ---------------- раскладка и масштаб ----------------
  function layout(resetZoom) {
    const st = stage().getBoundingClientRect();
    const iw = img().naturalWidth || 16;
    const ih = img().naturalHeight || 9;
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
    rc.zoom = Math.max(1, Math.min(4, rc.zoom));
    rc.tx = Math.min(0, Math.max(b.w - b.w * rc.zoom, rc.tx));
    rc.ty = Math.min(0, Math.max(b.h - b.h * rc.zoom, rc.ty));
    canvas().style.transform = `translate(${rc.tx}px, ${rc.ty}px) scale(${rc.zoom})`;
    $r('#rc-zoom').classList.toggle('hidden', rc.zoom <= 1.01);
  }

  /** Точка экрана телефона → координаты на экране ПК (0..1). */
  function norm(cx, cy) {
    const r = img().getBoundingClientRect();
    if (!r.width) return null;
    const x = (cx - r.left) / r.width;
    const y = (cy - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  // ---------------- жесты ----------------
  const pointers = new Map();
  let g = null;          // текущий жест одним пальцем
  let pinch = null;      // масштабирование двумя пальцами
  let multi = false;     // в жесте участвовали два пальца
  let lastTap = null;
  let lastMoveSent = 0;

  function onDown(e) {
    e.preventDefault();
    stage().setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      multi = false;
      g = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, long: false, dragging: false, acc: 0, accX: 0 };
      g.timer = setTimeout(() => {
        if (!g || g.moved || multi) return;
        const p = norm(g.sx, g.sy);
        if (!p) return;
        g.long = true;
        haptic(25);
        send({ type: 'click', button: 'right', ...p });
      }, 550);
    } else if (pointers.size === 2) {
      multi = true;
      if (g) clearTimeout(g.timer);
      if (g && g.dragging) { send({ type: 'up' }); g.dragging = false; }
      const [a, b] = [...pointers.values()];
      const st = stage().getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - st.left - rc.base.x, y: (a.y + b.y) / 2 - st.top - rc.base.y };
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: rc.zoom, tx: rc.tx, ty: rc.ty, mid };
    }
  }

  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const st = stage().getBoundingClientRect();
      const mid = { x: (a.x + b.x) / 2 - st.left - rc.base.x, y: (a.y + b.y) / 2 - st.top - rc.base.y };
      const z = Math.max(1, Math.min(4, pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist)));
      const cx = (pinch.mid.x - pinch.tx) / pinch.zoom;
      const cy = (pinch.mid.y - pinch.ty) / pinch.zoom;
      rc.zoom = z;
      rc.tx = mid.x - cx * z;
      rc.ty = mid.y - cy * z;
      applyTransform();
      return;
    }
    if (!g || multi) return;
    const dx = e.clientX - g.lx;
    const dy = e.clientY - g.ly;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 9) { g.moved = true; clearTimeout(g.timer); }
    if (!g.moved) return;
    if (rc.zoom > 1.01 && !rc.dragMode) {
      rc.tx += dx; rc.ty += dy; applyTransform();
    } else if (rc.dragMode) {
      if (!g.dragging) {
        const p0 = norm(g.sx, g.sy);
        if (p0) { send({ type: 'down', ...p0 }); g.dragging = true; }
      }
      const now = performance.now();
      if (g.dragging && now - lastMoveSent > 50) {
        const p = norm(e.clientX, e.clientY);
        if (p) { send({ type: 'move', ...p }); lastMoveSent = now; }
      }
    } else {
      // Прокрутка: палец вверх — страница вниз
      g.acc += dy; g.accX += dx;
      const step = 36;
      if (Math.abs(g.acc) >= step) {
        const n = Math.trunc(g.acc / step);
        g.acc -= n * step;
        send({ type: 'wheel', dy: n * 120 });
      }
      if (Math.abs(g.accX) >= step * 1.5) {
        const n = Math.trunc(g.accX / (step * 1.5));
        g.accX -= n * step * 1.5;
        send({ type: 'wheel', dx: -n * 120, dy: 0 });
      }
    }
    g.lx = e.clientX; g.ly = e.clientY;
  }

  function onUp(e) {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.dragging) {
      const p = norm(e.clientX, e.clientY);
      send({ type: 'up', ...(p || {}) });
    } else if (!g.moved && !g.long && !multi) {
      let p = norm(g.sx, g.sy);
      if (p) {
        const now = performance.now();
        // Второе нажатие рядом с первым — в ту же точку, чтобы Windows засчитала двойной клик
        if (lastTap && now - lastTap.t < 400 && Math.hypot(g.sx - lastTap.cx, g.sy - lastTap.cy) < 30) p = lastTap.p;
        const button = rc.rightNext ? 'right' : 'left';
        if (rc.rightNext) { rc.rightNext = false; $r('#rc-right').classList.remove('active'); }
        haptic(6);
        send({ type: 'click', button, ...p });
        lastTap = { t: now, cx: g.sx, cy: g.sy, p };
        flashTap(g.sx, g.sy);
      }
    }
    g = null;
    multi = false;
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
      if (added) send({ type: 'text', text: added });
      prevText = v;
      if (v.length > 300) { kbd.value = ''; prevText = ''; }
    });
    kbd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); send({ type: 'key', keys: 'enter' }); }
      else if (e.key === 'Backspace' && !kbd.value) { e.preventDefault(); send({ type: 'key', keys: 'backspace' }); }
    });
  }

  // ---------------- открыть / закрыть ----------------
  async function open() {
    let info;
    try { info = await api('/api/remote/info'); } catch (e) { toast(e.message, 'err'); return; }
    if (!info.enabled) { toast('Удалённое управление выключено в программе на ПК (Настройки → Приложение на телефоне)', 'err'); return; }
    rc.displays = info.displays;
    if (!rc.displays.some((d) => d.index === rc.monitor)) rc.monitor = (rc.displays.find((d) => d.primary) || rc.displays[0] || { index: 1 }).index;
    rc.open = true;
    $r('#remote').classList.remove('hidden');
    document.body.classList.add('rc-open');
    $r('#rc-monitor').classList.toggle('hidden', rc.displays.length < 2);
    $r('#rc-monitor-num').textContent = String(rc.monitor);
    $r('#rc-quality').textContent = QUALITY[rc.quality].name;
    try { rc.wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) { rc.wakeLock = null; }
    layout(true);
    loop();
  }

  function close() {
    rc.open = false;
    $r('#remote').classList.add('hidden');
    document.body.classList.remove('rc-open');
    $r('#rc-kbd').blur();
    if (rc.wakeLock) { rc.wakeLock.release().catch(() => {}); rc.wakeLock = null; }
  }

  function moreKeys() {
    const groups = [
      ['Правка', [['Ctrl+C', 'ctrl+c'], ['Ctrl+V', 'ctrl+v'], ['Ctrl+X', 'ctrl+x'], ['Ctrl+Z', 'ctrl+z'], ['Ctrl+A', 'ctrl+a'], ['Ctrl+S', 'ctrl+s']]],
      ['Окна', [['Alt+F4', 'alt+f4'], ['Win+D', 'win+d'], ['Win+E', 'win+e'], ['Win+Tab', 'win+tab'], ['Диспетчер задач', 'ctrl+shift+esc'], ['Win+L', 'win+l']]],
      ['Клавиши', [['Tab', 'tab'], ['Shift+Tab', 'shift+tab'], ['Delete', 'delete'], ['Home', 'home'], ['End', 'end'], ['PgUp', 'pgup'], ['PgDn', 'pgdn'], ['F5', 'f5'], ['F11', 'f11'], ['PrtSc', 'printscreen']]],
      ['Стрелки', [['←', 'left'], ['↑', 'up'], ['↓', 'down'], ['→', 'right']]],
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
    window.addEventListener('resize', () => { if (rc.open) layout(true); });
    bindKeyboard();

    $r('#rc-close').addEventListener('click', close);
    $r('#rc-kb').addEventListener('click', () => {
      const kbd = $r('#rc-kbd');
      if (document.activeElement === kbd) kbd.blur(); else { kbd.value = ''; prevText = ''; kbd.focus(); }
    });
    $r('#rc-mode').addEventListener('click', (e) => {
      rc.dragMode = !rc.dragMode;
      e.currentTarget.classList.toggle('active', rc.dragMode);
      $r('#rc-mode-label').textContent = rc.dragMode ? 'Тянуть' : 'Листать';
      toast(rc.dragMode ? 'Палец перетаскивает (выделение, перенос окон)' : 'Палец прокручивает', 'info');
    });
    $r('#rc-right').addEventListener('click', (e) => {
      rc.rightNext = !rc.rightNext;
      e.currentTarget.classList.toggle('active', rc.rightNext);
    });
    $r('#rc-zoom').addEventListener('click', () => { rc.zoom = 1; rc.tx = 0; rc.ty = 0; applyTransform(); });
    $r('#rc-quality').addEventListener('click', (e) => {
      rc.quality = (rc.quality + 1) % QUALITY.length;
      e.currentTarget.textContent = QUALITY[rc.quality].name;
    });
    $r('#rc-monitor').addEventListener('click', () => {
      const i = rc.displays.findIndex((d) => d.index === rc.monitor);
      rc.monitor = rc.displays[(i + 1) % rc.displays.length].index;
      $r('#rc-monitor-num').textContent = String(rc.monitor);
      layout(true);
    });
    document.querySelectorAll('[data-rckey]').forEach((b) => b.addEventListener('click', () => key(b.dataset.rckey)));
    $r('#rc-more').addEventListener('click', moreKeys);
    document.querySelectorAll('[data-open-remote]').forEach((b) => b.addEventListener('click', open));
  }

  window.RemoteControl = { open, close };
  init();
})();
