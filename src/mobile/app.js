'use strict';
// PC Full Control — мобильное приложение (работает с ПК по Wi-Fi).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const TOKEN_KEY = 'pcfc_token';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
};

// Открыто внутри Android-приложения (оболочки)?
const params = new URLSearchParams(location.search);
if (params.get('shell')) { try { sessionStorage.setItem('pcfc_shell', params.get('shell')); } catch (e) { /* ignore */ } }
const SHELL = (() => { try { return sessionStorage.getItem('pcfc_shell'); } catch (e) { return null; } })();
const IS_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let token = store.get(TOKEN_KEY);
let INFO = null;
let ACTIONS = {};
let tab = 'home';
let timers = {};

// ===================== утилиты =====================
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const ic = (name, size = 20) => Icons.el(name, size);
const haptic = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* ignore */ } };

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
}
const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

let toastTimer;
function toast(text, kind = 'ok') {
  const t = $('#toast');
  t.replaceChildren(ic(kind === 'err' ? 'alert' : kind === 'info' ? 'info' : 'check', 18), el('span', { text }));
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), Math.min(7000, 2200 + text.length * 30));
}

// ===================== API =====================
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method, json, body, raw, headers = {} } = {}) {
  if (token) headers.Authorization = 'Bearer ' + token;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  let r;
  try {
    r = await fetch(path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers, body });
  } catch (e) {
    setOnline(false);
    throw new ApiError('Нет связи с компьютером. Он включён и в той же сети Wi-Fi?', 0);
  }
  setOnline(true);
  if (r.status === 401) {
    token = null;
    store.del(TOKEN_KEY);
    showPair();
    throw new ApiError('Телефон не привязан', 401);
  }
  if (!r.ok) {
    let msg = `Ошибка ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (e) { /* не JSON */ }
    throw new ApiError(msg, r.status);
  }
  if (raw) return r;
  return r.json();
}

function setOnline(on) {
  const d = $('#online-dot');
  d.classList.toggle('on', on);
  d.classList.toggle('off', !on);
  if (!on) $('#pc-sub').textContent = 'нет связи';
  else if (INFO) $('#pc-sub').textContent = 'в сети · ' + INFO.os;
}

// ===================== нижняя панель =====================
let sheetResolve = null;
function openSheet(title, body) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(...[].concat(body));
  $('#sheet-backdrop').classList.remove('hidden');
  requestAnimationFrame(() => $('#sheet').classList.add('open'));
  return new Promise((res) => { sheetResolve = res; });
}
function closeSheet(value = null) {
  $('#sheet').classList.remove('open');
  $('#sheet-backdrop').classList.add('hidden');
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(value); }
}
$('#sheet-backdrop').addEventListener('click', () => closeSheet(null));

function confirmSheet(title, text, yes = 'Да', danger = true, icon = 'alert') {
  return openSheet(title, [
    el('p', { text }),
    el('div', { class: 'sheet-options' },
      el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => closeSheet(true) }, ic(icon, 18), yes),
      el('button', { class: 'btn', onclick: () => closeSheet(false) }, ic('x', 18), 'Отмена')),
  ]);
}

function promptSheet(title, hint, { multiline = false, value = '' } = {}) {
  const input = multiline
    ? el('textarea', { class: 'input', placeholder: hint })
    : el('input', { class: 'input', placeholder: hint, autocapitalize: 'off' });
  input.value = value;
  const ok = () => { if (input.value.trim()) closeSheet(input.value.trim()); else input.focus(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) ok(); });
  const p = openSheet(title, [input, el('button', { class: 'btn primary big', onclick: ok }, ic('check', 18), 'Готово')]);
  setTimeout(() => input.focus(), 350);
  return p;
}

// ===================== привязка =====================
function showPair() {
  stopTimers();
  $('#app').classList.add('hidden');
  $('#pair').classList.remove('hidden');
  const name = $('#device-name');
  if (!name.value) name.value = IS_IOS ? 'iPhone' : /android/i.test(navigator.userAgent) ? 'Android' : 'Телефон';
}

const otpInputs = $$('#otp input');
otpInputs.forEach((inp, i) => {
  inp.addEventListener('input', () => {
    const digits = inp.value.replace(/\D/g, '');
    if (digits.length > 1) { // вставка всего кода
      digits.slice(0, 6).split('').forEach((d, j) => { if (otpInputs[j]) otpInputs[j].value = d; });
      otpInputs[Math.min(digits.length, 6) - 1].focus();
    } else {
      inp.value = digits;
      if (digits && otpInputs[i + 1]) otpInputs[i + 1].focus();
    }
    if (otpInputs.every((x) => x.value)) $('#pair-form').requestSubmit();
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !inp.value && otpInputs[i - 1]) otpInputs[i - 1].focus(); });
});

async function doPair(code) {
  $('#pair-error').textContent = '';
  try {
    const res = await api('/api/pair', {
      json: { code, name: $('#device-name').value.trim() || 'Телефон', platform: IS_IOS ? 'ios' : /android/i.test(navigator.userAgent) ? 'android' : 'web' },
    });
    token = res.token;
    store.set(TOKEN_KEY, token);
    history.replaceState(null, '', location.pathname + location.search);
    haptic(20);
    await startApp();
    toast(`Телефон привязан к «${res.pcName}»`);
  } catch (e) {
    $('#pair-auto').classList.add('hidden');
    $('#pair-form').classList.remove('hidden');
    $('#pair-error').textContent = e.message;
    otpInputs.forEach((x) => { x.value = ''; });
    otpInputs[0].focus();
  }
}

$('#pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = otpInputs.map((x) => x.value).join('');
  if (code.length === 6) doPair(code);
});

// ===================== запуск =====================
async function startApp() {
  INFO = await api('/api/info');
  ACTIONS = Object.fromEntries(INFO.actions.map((a) => [a.name, a]));
  $('#pair').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#pc-name').textContent = INFO.pcName;
  setOnline(true);
  $('#about-pc').textContent = INFO.pcName;
  $('#about-os').textContent = INFO.os;
  $('#about-version').textContent = INFO.version;
  $('#about-device').textContent = INFO.device.name;
  $('#switch-pc').classList.toggle('hidden', !SHELL);
  $('#terminal-card').classList.toggle('hidden', !INFO.allowShell);
  renderControl();
  renderMonitors();
  renderInstallHint();
  switchTab(tab);
}

function stopTimers() { Object.values(timers).forEach(clearInterval); timers = {}; }

$$('.tabbar button').forEach((b) => b.addEventListener('click', () => { haptic(); switchTab(b.dataset.tab); }));
$('#refresh').addEventListener('click', () => { haptic(); switchTab(tab); });

function switchTab(t) {
  tab = t;
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.view !== t));
  $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  clearInterval(timers.status);
  if (t === 'home') {
    loadStatus(); loadChart();
    timers.status = setInterval(() => { if (!document.hidden) loadStatus(); }, 4000);
  } else if (t === 'proc') loadProcesses();
  else if (t === 'files') loadFiles(filesPath);
  else if (t === 'more') loadMore();
  window.scrollTo({ top: 0 });
}

// ===================== действия =====================
async function runAction(name, arg = '', { quiet = false, tileEl = null } = {}) {
  const a = ACTIONS[name];
  if (!a) return null;
  if (a.argRequired && !arg) {
    arg = await promptSheet(a.title, a.argHint, { multiline: ['message', 'say', 'clipboard_set'].includes(name) });
    if (!arg) return null;
  }
  if (a.dangerous && INFO.confirmDangerous) {
    const ok = await confirmSheet(a.title + '?', arg ? `Параметр: ${arg}` : 'Действие будет выполнено на компьютере.', a.title, true, Icons.ACTION_ICONS[name] || 'alert');
    if (!ok) return null;
  }
  haptic(12);
  if (tileEl) tileEl.classList.add('busy');
  try {
    const r = await api('/api/action/' + name, { json: { arg } });
    if (name === 'clipboard_get' && r.ok) {
      openSheet('Буфер обмена ПК', [el('pre', { class: 'output', text: r.result }),
        el('button', { class: 'btn big', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(r.result).then(() => toast('Скопировано')); closeSheet(); } }, ic('copy', 18), 'Скопировать на телефон')]);
    } else if (!quiet || !r.ok) {
      toast(r.result, r.ok ? 'ok' : 'err');
    }
    if (a.category === 'media') setTimeout(loadStatus, 400);
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  } finally {
    if (tileEl) tileEl.classList.remove('busy');
  }
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b) runAction(b.dataset.act, b.dataset.arg || '', { quiet: b.classList.contains('round-btn') });
  const p = e.target.closest('[data-power]');
  if (p) powerSheet(p.dataset.power);
});

async function powerSheet(name) {
  const a = ACTIONS[name];
  if (!a) return;
  const pick = await openSheet(a.title, [
    el('p', { text: 'Когда выполнить?' }),
    el('div', { class: 'sheet-options' },
      el('button', { class: 'btn danger', onclick: () => closeSheet('0') }, ic(name === 'shutdown' ? 'power' : 'restart', 18), 'Сейчас'),
      ...[15, 30, 60, 120].map((m) => el('button', { class: 'btn', onclick: () => closeSheet(String(m)) }, ic('clock', 18), `Через ${m < 60 ? m + ' мин' : m / 60 + ' ч'}`)),
      el('button', { class: 'btn', onclick: () => closeSheet('cancel') }, ic('cancel', 18), 'Отменить запланированное'),
    ),
  ]);
  if (pick === null) return;
  haptic(20);
  if (pick === 'cancel') { runAction('cancel_shutdown'); return; }
  try {
    const r = await api('/api/action/' + name, { json: { arg: pick === '0' ? '' : pick } });
    toast(r.result, r.ok ? 'ok' : 'err');
  } catch (e) { toast(e.message, 'err'); }
}

// ===================== главная =====================
function ring(label, percent, sub, color) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent || 0));
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 84 84');
  const track = document.createElementNS(svgNs, 'circle');
  Object.entries({ cx: 42, cy: 42, r, fill: 'none', 'stroke-width': 8, class: 'track' }).forEach(([k, v]) => track.setAttribute(k, v));
  const val = document.createElementNS(svgNs, 'circle');
  Object.entries({ cx: 42, cy: 42, r, fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round', class: 'val', stroke: color, 'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - p / 100) }).forEach(([k, v]) => val.setAttribute(k, v));
  svg.append(track, val);
  return el('div', { class: 'gauge' },
    el('div', { class: 'ring' }, svg, el('div', { class: 'ring-num' }, el('span', {}, Math.round(p), el('small', { text: '%' })))),
    el('div', { class: 'gauge-label', text: label }),
    el('div', { class: 'gauge-sub', text: sub || '' }));
}

function chip(icon, label, value) {
  return el('div', { class: 'chip' }, el('div', { class: 'chip-ic' }, ic(icon, 18)),
    el('div', { class: 'chip-text' }, el('div', { class: 'chip-label', text: label }), el('div', { class: 'chip-val', text: value })));
}

let volDragging = false;
async function loadStatus() {
  let s;
  try { s = await api('/api/status'); } catch (e) { return; }
  const css = getComputedStyle(document.documentElement);
  const disk = s.disks.length ? s.disks.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  $('#gauges').replaceChildren(
    ring('Процессор', s.cpu.percent, `${s.cpu.threads} потоков`, css.getPropertyValue('--cpu')),
    ring('Память', s.ram.percent, fmtBytes(s.ram.used), css.getPropertyValue('--ram')),
    ring(disk ? 'Диск ' + disk.mount.replace(/\\$/, '') : 'Диск', disk ? disk.percent : 0, disk ? 'свободно ' + fmtBytes(disk.free) : '', css.getPropertyValue('--disk')),
  );
  const chips = [chip('clock', 'Работает', fmtDur(s.uptime))];
  if (s.temp !== null && s.temp !== undefined) chips.push(chip('temp', 'Температура', Math.round(s.temp) + '°C'));
  for (const g of s.gpus || []) chips.push(chip('gpu', 'Видеокарта', `${Math.round(g.util)}%${g.temp !== null ? ' · ' + Math.round(g.temp) + '°C' : ''}`));
  if (s.battery) chips.push(chip('battery', 'Батарея', `${s.battery.percent}%${s.battery.plugged ? ' · заряжается' : ''}`));
  chips.push(chip('wifi', 'IP-адрес', s.ips[0] || '—'));
  if (s.users && s.users.length) chips.push(chip('user', 'Пользователь', s.users.join(', ')));
  $('#chips').replaceChildren(...chips);
  if (s.volume && !volDragging) setVolumeUi(s.volume.level, s.volume.muted);
  $('#notif-toggle').checked = !s.muted;
}

function setVolumeUi(level, muted) {
  const v = $('#volume');
  v.value = level;
  v.style.setProperty('--p', level + '%');
  $('#vol-label').textContent = muted ? 'без звука' : level + '%';
}
$('#volume').addEventListener('input', (e) => { volDragging = true; setVolumeUi(e.target.value, false); });
$('#volume').addEventListener('change', async (e) => {
  await runAction('set_volume', e.target.value, { quiet: true });
  volDragging = false;
});

async function loadChart() {
  let data;
  try { data = await api('/api/metrics?hours=1'); } catch (e) { return; }
  const c = $('#chart');
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth; const h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  if (data.length < 2) {
    g.fillStyle = css.getPropertyValue('--dim');
    g.font = '13px -apple-system, Roboto, sans-serif';
    g.fillText('Данные собираются…', 8, h / 2);
    return;
  }
  const t0 = data[0].ts; const t1 = data[data.length - 1].ts;
  const x = (t) => (w * (t - t0)) / Math.max(1, t1 - t0);
  const y = (v) => 6 + (h - 12) * (1 - Math.min(100, Math.max(0, v)) / 100);
  for (const [key, color] of [['ram', '--ram'], ['cpu', '--cpu']]) {
    const col = css.getPropertyValue(color).trim();
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, col + '55');
    grad.addColorStop(1, col + '00');
    g.beginPath();
    data.forEach((p, i) => (i ? g.lineTo(x(p.ts), y(p[key])) : g.moveTo(x(p.ts), y(p[key]))));
    g.strokeStyle = col; g.lineWidth = 2.2; g.lineJoin = 'round'; g.stroke();
    g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    g.fillStyle = grad; g.fill();
  }
}

// --- экран ---
let monitor = 1;
function renderMonitors() {
  const seg = $('#monitor-seg');
  seg.classList.toggle('hidden', (INFO.monitors || 1) < 2);
  seg.replaceChildren(...Array.from({ length: INFO.monitors || 1 }, (_, i) =>
    el('button', { class: i + 1 === monitor ? 'active' : '', text: 'Экран ' + (i + 1), onclick: (e) => { monitor = i + 1; $$('button', seg).forEach((b) => b.classList.toggle('active', b === e.target)); takeShot(); } })));
}

async function loadImage(url, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(url, { raw: true });
    const blob = await r.blob();
    const img = $('#shot');
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(blob);
    img.classList.remove('hidden');
    $('#shot-empty').classList.add('hidden');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}
const takeShot = () => loadImage('/api/screenshot?monitor=' + monitor, $('#btn-shot'));
$('#btn-shot').addEventListener('click', () => { haptic(); takeShot(); });
$('#shot-box').addEventListener('click', () => {
  const img = $('#shot');
  if (img.classList.contains('hidden')) { takeShot(); return; }
  $('#viewer-img').src = img.src;
  $('#viewer').classList.remove('hidden');
});
$('#btn-cam').addEventListener('click', () => { haptic(); loadImage('/api/webcam', $('#btn-cam')); });
$('#viewer-close').addEventListener('click', () => $('#viewer').classList.add('hidden'));
$('#auto-shot').addEventListener('change', (e) => {
  clearInterval(timers.shot);
  if (e.target.checked) {
    takeShot();
    timers.shot = setInterval(() => { if (!document.hidden && tab === 'home') takeShot(); }, 3000);
  }
});

// ===================== пульт =====================
const CONTROL = [
  ['Питание', [['shutdown', 'danger'], ['reboot', 'warn'], ['sleep'], ['hibernate'], ['lock'], ['logoff'], ['monitor_off'], ['cancel_shutdown']]],
  ['Обновление ПО', [['check_updates', 'cyan'], ['upgrade_all', 'cyan'], ['win_update_check', 'cyan'], ['win_update_install', 'cyan'], ['app_update', 'green']]],
  ['Экран и Telegram', [['screenshot'], ['webcam'], ['status_report']]],
  ['Разное', [['message'], ['say'], ['open_url'], ['launch'], ['clipboard_get'], ['clipboard_set'], ['notify'], ['empty_recycle_bin', 'warn'], ['restart_app']]],
];
const SHORT = {
  shutdown: 'Выключить', reboot: 'Перезагрузка', cancel_shutdown: 'Отмена выкл.', monitor_off: 'Монитор',
  check_updates: 'Проверить', upgrade_all: 'Обновить всё', win_update_check: 'Windows Update', win_update_install: 'Установить Windows',
  app_update: 'Обновить PC Control', status_report: 'Отчёт в Telegram', screenshot: 'Скриншот в Telegram', webcam: 'Камера в Telegram',
  open_url: 'Ссылка', launch: 'Запустить', clipboard_get: 'Буфер ПК', clipboard_set: 'В буфер ПК', notify: 'Напоминание',
  empty_recycle_bin: 'Корзина', restart_app: 'Перезапуск', message: 'Сообщение', say: 'Озвучить', lock: 'Блокировка',
  logoff: 'Выход', sleep: 'Сон', hibernate: 'Гибернация',
};

function tile(name, tone = '') {
  const a = ACTIONS[name];
  if (!a) return null;
  const t = el('button', { class: 'tile ' + tone },
    el('span', { class: 'tile-ic' }, ic(Icons.ACTION_ICONS[name] || 'zap', 22)), el('span', { text: SHORT[name] || a.title }));
  t.addEventListener('click', () => {
    if (name === 'shutdown' || name === 'reboot') powerSheet(name);
    else runAction(name, '', { tileEl: t });
  });
  return t;
}

function renderControl() {
  const box = $('#control-sections');
  box.replaceChildren();
  for (const [title, items] of CONTROL) {
    const tiles = items.map(([n, tone]) => tile(n, tone)).filter(Boolean);
    if (tiles.length) box.append(el('div', { class: 'section-title', text: title }), el('div', { class: 'tiles' }, tiles));
  }
  if (INFO.apps.length) {
    box.append(el('div', { class: 'section-title', text: 'Мои программы' }), el('div', { class: 'tiles' },
      INFO.apps.map((name, i) => {
        const t = el('button', { class: 'tile green' }, el('span', { class: 'tile-ic' }, ic('rocket', 22)), el('span', { text: name }));
        t.addEventListener('click', async () => {
          haptic(12);
          t.classList.add('busy');
          try { const r = await api('/api/apps/' + i, { method: 'POST' }); toast(r.result, r.ok ? 'ok' : 'err'); } catch (e) { toast(e.message, 'err'); }
          t.classList.remove('busy');
        });
        return t;
      })));
  }
}

$('#terminal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('#terminal-input').value.trim();
  if (!cmd) return;
  const out = $('#terminal-output');
  out.classList.remove('hidden');
  out.textContent = 'PS> ' + cmd + '\nВыполняется…';
  try { out.textContent = (await api('/api/action/shell', { json: { arg: cmd } })).result; } catch (err) { out.textContent = err.message; }
});

// ===================== процессы =====================
let procSort = 'cpu';
let procTimer;
$('#proc-search').addEventListener('input', () => { clearTimeout(procTimer); procTimer = setTimeout(loadProcesses, 350); });
$$('#proc-sort button').forEach((b) => b.addEventListener('click', () => {
  procSort = b.dataset.sort;
  $$('#proc-sort button').forEach((x) => x.classList.toggle('active', x === b));
  loadProcesses();
}));

async function loadProcesses() {
  const list = $('#proc-list');
  if (!list.children.length) list.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skeleton' })));
  let procs;
  try { procs = await api(`/api/processes?sort=${procSort}&q=${encodeURIComponent($('#proc-search').value.trim())}&limit=80`); } catch (e) { toast(e.message, 'err'); return; }
  if (!procs.length) { list.replaceChildren(el('div', { class: 'empty' }, ic('search', 30), 'Ничего не найдено')); return; }
  const maxCpu = Math.max(10, ...procs.map((p) => p.cpu));
  list.replaceChildren(...procs.map((p) => {
    const bar = el('i');
    bar.style.width = Math.min(100, (p.cpu / maxCpu) * 100) + '%';
    return el('div', { class: 'item tap', onclick: () => procSheet(p) },
      el('div', { class: 'item-ic' }, ic('package', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: p.name }),
        el('div', { class: 'item-sub', text: `PID ${p.pid} · ${fmtBytes(p.mem)}` }), el('div', { class: 'mini-bar' }, bar)),
      el('div', { class: 'cpu-num', text: p.cpu + '%' }));
  }));
}

async function procSheet(p) {
  const res = await openSheet(p.name, [
    el('p', { text: `PID ${p.pid} · CPU ${p.cpu}% · память ${fmtBytes(p.mem)}${p.user ? ' · ' + p.user : ''}` }),
    el('div', { class: 'sheet-options' },
      el('button', { class: 'btn danger', onclick: () => closeSheet('kill') }, ic('x', 18), 'Завершить процесс'),
      el('button', { class: 'btn', onclick: () => closeSheet('killall') }, ic('trash', 18), `Завершить все «${p.name}»`),
      el('button', { class: 'btn', onclick: () => closeSheet(null) }, ic('chevronLeft', 18), 'Назад')),
  ]);
  if (!res) return;
  haptic(20);
  try {
    const r = await api('/api/action/kill', { json: { arg: res === 'kill' ? String(p.pid) : p.name } });
    toast(r.result, r.ok ? 'ok' : 'err');
    loadProcesses();
  } catch (e) { toast(e.message, 'err'); }
}

// ===================== файлы =====================
let filesPath = '';
let filesParent = null;
$('#files-up').addEventListener('click', () => loadFiles(filesParent || ''));
$('#files-root').addEventListener('click', () => loadFiles(''));

const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i;
async function loadFiles(p) {
  let res;
  try { res = await api('/api/files?path=' + encodeURIComponent(p || '')); } catch (e) { toast(e.message, 'err'); return; }
  filesPath = res.path;
  filesParent = res.parent;
  $('#files-path').textContent = res.path || 'Расположения';
  $('#files-up').disabled = !res.path;
  const list = $('#files-list');
  if (!res.entries.length) { list.replaceChildren(el('div', { class: 'empty' }, ic('folder', 30), 'Папка пуста')); return; }
  list.replaceChildren(...res.entries.slice(0, 500).map((f) => el('div', { class: 'item tap', onclick: () => (f.isDir ? loadFiles(f.path) : fileSheet(f)) },
    el('div', { class: 'item-ic' + (f.isDir ? ' folder' : '') }, ic(f.isDir ? (res.path ? 'folder' : 'disk') : IMG_EXT.test(f.name) ? 'image' : 'file', 18)),
    el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: f.name }),
      f.isDir ? null : el('div', { class: 'item-sub', text: fmtBytes(f.size) + (f.mtime ? ' · ' + fmtTime(f.mtime) : '') })),
    f.isDir ? ic('chevronRight', 18) : null)));
  window.scrollTo({ top: 0 });
}

async function fileBlob(f) {
  const r = await api('/api/files/download?path=' + encodeURIComponent(f.path), { raw: true });
  return r.blob();
}

async function fileSheet(f) {
  const body = [el('p', { text: `${fmtBytes(f.size)}${f.mtime ? ' · ' + fmtTime(f.mtime) : ''}` })];
  if (IMG_EXT.test(f.name) && f.size < 25 * 1024 * 1024) {
    const img = el('img', { class: 'preview-img', alt: '' });
    fileBlob(f).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => img.remove());
    body.unshift(img);
  }
  const opts = el('div', { class: 'sheet-options' });
  if (!SHELL) opts.append(el('button', { class: 'btn', onclick: () => closeSheet('download') }, ic('download', 18), 'Скачать на телефон'));
  if (INFO.telegram) opts.append(el('button', { class: 'btn', onclick: () => closeSheet('telegram') }, ic('telegram', 18), 'Отправить в Telegram'));
  opts.append(el('button', { class: 'btn', onclick: () => closeSheet('open') }, ic('rocket', 18), 'Открыть на компьютере'));
  opts.append(el('button', { class: 'btn', onclick: () => closeSheet(null) }, ic('chevronLeft', 18), 'Назад'));
  body.push(opts);
  const act = await openSheet(f.name, body);
  if (act === 'download') {
    toast('Скачиваю…', 'info');
    try {
      const blob = await fileBlob(f);
      const a = el('a', { href: URL.createObjectURL(blob), download: f.name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    } catch (e) { toast(e.message, 'err'); }
  } else if (act === 'telegram') {
    try { await api('/api/files/telegram', { json: { path: f.path } }); toast('Файл отправлен в Telegram'); } catch (e) { toast(e.message, 'err'); }
  } else if (act === 'open') {
    runAction('launch', f.path);
  }
}

$('#file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  const box = $('#upload-progress');
  box.classList.remove('hidden');
  for (const [i, file] of files.entries()) {
    $('#upload-text').textContent = `Загрузка ${i + 1}/${files.length}: ${file.name}`;
    try {
      await uploadFile(file, (p) => { $('#upload-bar').style.width = Math.round(p * 100) + '%'; });
      toast('Сохранено на ПК: ' + file.name);
    } catch (err) { toast(err.message, 'err'); }
  }
  box.classList.add('hidden');
  e.target.value = '';
  if (filesPath) loadFiles(filesPath);
});

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/files/upload?name=${encodeURIComponent(file.name)}&dir=${encodeURIComponent(filesPath || '')}`);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else { try { reject(new Error(JSON.parse(xhr.responseText).error)); } catch (e) { reject(new Error('Ошибка ' + xhr.status)); } }
    };
    xhr.onerror = () => reject(new Error('Нет связи с компьютером'));
    xhr.send(file);
  });
}

// ===================== ещё =====================
let morePane = 'tasks';
let logMode = 'events';
$$('#more-seg button').forEach((b) => b.addEventListener('click', () => {
  morePane = b.dataset.more;
  $$('#more-seg button').forEach((x) => x.classList.toggle('active', x === b));
  loadMore();
}));
$$('#log-seg button').forEach((b) => b.addEventListener('click', () => {
  logMode = b.dataset.log;
  $$('#log-seg button').forEach((x) => x.classList.toggle('active', x === b));
  loadLog();
}));

function loadMore() {
  $$('.more-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== morePane));
  if (morePane === 'tasks') loadTasks();
  else if (morePane === 'log') loadLog();
  else loadStatus();
}

async function loadTasks() {
  let tasks;
  try { tasks = await api('/api/tasks'); } catch (e) { return; }
  const list = $('#tasks-list');
  if (!tasks.length) { list.replaceChildren(el('div', { class: 'empty' }, ic('calendar', 30), 'Задач пока нет')); return; }
  list.replaceChildren(...tasks.map((t) => {
    const sw = el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: !!t.enabled }), el('span'));
    sw.addEventListener('click', async (e) => {
      e.preventDefault();
      haptic();
      await api(`/api/tasks/${t.id}/toggle`, { method: 'POST' }).catch((er) => toast(er.message, 'err'));
      loadTasks();
    });
    return el('div', { class: 'item' + (t.enabled ? '' : ' off') },
      el('div', { class: 'item-ic' }, ic(Icons.ACTION_ICONS[t.action] || 'clock', 18)),
      el('div', { class: 'item-main', onclick: () => taskSheet(t) }, el('div', { class: 'item-title wrap', text: t.description.replace(/^#\d+\s*(🔁|🕐)?\s*/u, '') }),
        t.last_run ? el('div', { class: 'item-sub', text: 'последний запуск: ' + fmtTime(t.last_run) }) : null),
      sw);
  }));
}

async function taskSheet(t) {
  const del = await confirmSheet('Удалить задачу?', t.description, 'Удалить', true, 'trash');
  if (!del) return;
  await api('/api/tasks/' + t.id, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
  loadTasks();
}

$('#add-task').addEventListener('click', async () => {
  const st = { kind: 'in', delay: 60, days: [0, 1, 2, 3, 4, 5, 6] };
  const select = el('select', { class: 'input' });
  const cats = { power: 'Питание', media: 'Звук', updates: 'Обновления', system: 'Система', misc: 'Разное' };
  for (const [cat, title] of Object.entries(cats)) {
    const g = el('optgroup', { label: title });
    INFO.actions.filter((a) => a.category === cat).forEach((a) => g.append(el('option', { value: a.name, text: a.title })));
    if (g.children.length) select.append(g);
  }
  const arg = el('input', { class: 'input hidden', placeholder: '' });
  const updArg = () => { const a = ACTIONS[select.value]; arg.classList.toggle('hidden', !(a && a.argHint)); arg.placeholder = a ? a.argHint : ''; };
  select.addEventListener('change', updArg);
  updArg();
  const kinds = el('div', { class: 'chips-pick' });
  const inBox = el('div', { class: 'chips-pick' }, ...[15, 30, 60, 120, 240].map((m) => el('button', { class: m === 60 ? 'active' : '', text: m < 60 ? `${m} мин` : `${m / 60} ч`, onclick: (e) => { st.delay = m; $$('button', inBox).forEach((b) => b.classList.toggle('active', b === e.target)); } })));
  const atBox = el('input', { class: 'input hidden', type: 'datetime-local' });
  const dt = new Date(Date.now() + 3600e3);
  dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  atBox.value = dt.toISOString().slice(0, 16);
  const timeIn = el('input', { class: 'input', type: 'time', value: '23:00' });
  const days = el('div', { class: 'weekdays' }, ...['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d, i) => el('button', { class: 'active', text: d, onclick: (e) => {
    e.target.classList.toggle('active');
    st.days = $$('button', days).map((b, j) => (b.classList.contains('active') ? j : -1)).filter((j) => j >= 0);
  } })));
  const dailyBox = el('div', { class: 'hidden' }, timeIn, el('div', { class: 'gap-v' }), days);
  const setKind = (k) => {
    st.kind = k;
    $$('button', kinds).forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    inBox.classList.toggle('hidden', k !== 'in');
    atBox.classList.toggle('hidden', k !== 'at');
    dailyBox.classList.toggle('hidden', k !== 'daily');
  };
  [['in', 'Через время'], ['at', 'В момент'], ['daily', 'По расписанию']].forEach(([k, t]) => kinds.append(el('button', { 'data-k': k, text: t, onclick: () => setKind(k) })));
  setKind('in');
  const err = el('p', { class: 'error' });
  const save = el('button', { class: 'btn primary big' }, ic('check', 18), 'Добавить задачу');
  save.addEventListener('click', async () => {
    const body = { action: select.value, arg: arg.value.trim(), kind: st.kind };
    if (st.kind === 'in') body.delayMinutes = st.delay;
    if (st.kind === 'at') body.runAt = atBox.value;
    if (st.kind === 'daily') { body.timeOfDay = timeIn.value; body.weekdays = st.days; }
    try {
      await api('/api/tasks', { json: body });
      closeSheet(true);
      toast('Задача добавлена');
      loadTasks();
    } catch (e) { err.textContent = e.message; }
  });
  openSheet('Новая задача', [el('label', { class: 'field-label', text: 'Действие' }), select, el('div', { class: 'gap-v' }), arg,
    el('label', { class: 'field-label', text: 'Когда' }), kinds, inBox, atBox, dailyBox, err, save]);
});

async function loadLog() {
  let rows;
  try { rows = await api('/api/log?mode=' + logMode); } catch (e) { return; }
  const list = $('#log-list');
  if (!rows.length) { list.replaceChildren(el('div', { class: 'empty' }, ic('list', 30), 'Пока пусто')); return; }
  const lvl = { info: 'info', warning: 'alert', critical: 'alert' };
  const src = { telegram: 'Telegram', app: 'ПК', scheduler: 'планировщик', mobile: 'телефон' };
  if (logMode === 'jobs') {
    list.replaceChildren(...rows.map((j) => el('div', { class: 'item tap', onclick: () => openSheet(j.title, [el('pre', { class: 'output', text: j.status === 'running' ? 'Выполняется…' : (j.output || '(нет вывода)') })]) },
      el('div', { class: 'item-ic' }, ic(j.status === 'running' ? 'hourglass' : j.status === 'done' ? 'check' : 'alert', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: j.title }), el('div', { class: 'item-sub', text: fmtTime(j.started) })),
      el('span', { class: 'badge ' + (j.status === 'done' ? 'ok' : j.status === 'error' ? 'err' : 'run'), text: j.status === 'done' ? 'готово' : j.status === 'error' ? 'ошибка' : 'идёт' }))));
  } else if (logMode === 'commands') {
    list.replaceChildren(...rows.map((r) => el('div', { class: 'item' },
      el('div', { class: 'item-ic' }, ic(Icons.ACTION_ICONS[r.action] || 'zap', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: (ACTIONS[r.action] ? ACTIONS[r.action].title : r.action) + (r.arg ? ' · ' + r.arg : '') }),
        el('div', { class: 'item-sub', text: `${fmtTime(r.ts)} · ${src[r.source] || r.source}` })),
      el('span', { class: 'badge ' + (r.ok ? 'ok' : 'err'), text: r.ok ? 'ок' : 'ошибка' }))));
  } else {
    list.replaceChildren(...rows.map((r) => el('div', { class: 'item' },
      el('div', { class: 'item-ic' }, ic(lvl[r.level] || 'info', 18)),
      el('div', { class: 'item-main' }, el('div', { class: 'item-title wrap', text: r.message }), el('div', { class: 'log-time', text: fmtTime(r.ts) })))));
  }
}

$('#notif-toggle').addEventListener('change', async (e) => {
  try {
    await api('/api/notifications', { json: { muted: !e.target.checked } });
    toast(e.target.checked ? 'Уведомления включены' : 'Уведомления выключены');
  } catch (err) { toast(err.message, 'err'); }
});

$('#unpair').addEventListener('click', async () => {
  if (!(await confirmSheet('Отвязать телефон?', 'Этот телефон больше не сможет управлять компьютером, пока вы не привяжете его снова.', 'Отвязать', true, 'logout'))) return;
  try { await api('/api/unpair', { method: 'POST' }); } catch (e) { /* ignore */ }
  token = null;
  store.del(TOKEN_KEY);
  showPair();
});

$('#switch-pc').addEventListener('click', () => { location.href = 'http://localhost/?list=1'; });

function renderInstallHint() {
  const card = $('#install-card');
  if (STANDALONE || SHELL) { card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  $('#install-text').textContent = IS_IOS
    ? 'В Safari нажмите кнопку «Поделиться» (квадрат со стрелкой) → «На экран Домой». Появится значок приложения.'
    : 'В меню браузера (⋮) выберите «Добавить на главный экран» — или установите Android-приложение со страницы релизов.';
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && token && tab === 'home') loadStatus(); });

// ===================== старт =====================
Icons.hydrate();

async function pairFromHash() {
  const m = location.hash.match(/#\/pair\/(\d{6})/);
  if (!m) return false;
  showPair();
  $('#pair-form').classList.add('hidden');
  $('#pair-auto').classList.remove('hidden');
  await doPair(m[1]);
  return true;
}
window.addEventListener('hashchange', pairFromHash);

(async () => {
  if (await pairFromHash()) return;
  if (!token) { showPair(); return; }
  try { await startApp(); } catch (e) { if (e.status !== 401) { showPair(); $('#pair-error').textContent = e.message; } }
})();
