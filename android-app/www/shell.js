'use strict';
// Android-приложение PC Control: список компьютеров, сканер QR-кода, подключение.
// После выбора компьютера приложение открывает его мобильный интерфейс (он работает на самом ПК).
const $ = (s) => document.querySelector(s);
const KEY = 'pcfc_pcs';
const DEFAULT_PORT = 8765;

function loadPcs() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
}
function savePcs(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) n.append(c instanceof Node ? c : String(c));
  return n;
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

/** Приводит «192.168.1.5», «192.168.1.5:8765», «http://…» к виду http://host:port */
function normalizeAddress(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.port) u.port = String(DEFAULT_PORT);
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch (e) {
    return null;
  }
}

async function hello(base, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(base + '/api/hello', { signal: ctrl.signal, cache: 'no-store' });
    const j = await r.json();
    return j && j.app === 'pc-full-control' ? j : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function openPc(base, hash = '') {
  const list = loadPcs();
  const pc = list.find((p) => p.url === base);
  if (pc) { pc.last = Date.now(); savePcs(list); }
  try { localStorage.setItem('pcfc_last', base); } catch (e) { /* ignore */ }
  location.href = `${base}/?shell=android${hash}`;
}

async function addPc(base, hash = '') {
  const info = await hello(base, 6000);
  if (!info) {
    toast('Компьютер не отвечает. Проверьте, что программа запущена и телефон в той же сети Wi-Fi.');
    return false;
  }
  const list = loadPcs().filter((p) => p.url !== base);
  list.unshift({ url: base, name: info.pcName, last: Date.now() });
  savePcs(list);
  openPc(base, hash);
  return true;
}

// ---------------- список ----------------
async function render() {
  const list = loadPcs().sort((a, b) => (b.last || 0) - (a.last || 0));
  const box = $('#pcs');
  $('#pcs-title').classList.toggle('hidden', !list.length);
  if (!list.length) {
    box.replaceChildren(el('div', { class: 'empty', text: 'Компьютеров пока нет — отсканируйте QR-код с экрана ПК.' }));
    return;
  }
  box.replaceChildren(...list.map((pc) => {
    const dot = el('span', { class: 'dot' });
    const row = el('div', { class: 'pc', onclick: async () => {
      dot.className = 'dot';
      if (await hello(pc.url)) openPc(pc.url);
      else { dot.className = 'dot off'; toast(`«${pc.name}» недоступен. Компьютер включён и в той же сети Wi-Fi?`); }
    } },
    el('div', { class: 'pc-ic' }, Icons.el('monitor', 22)),
    el('div', { class: 'pc-main' }, el('div', { class: 'pc-name', text: pc.name }), el('div', { class: 'pc-addr' }, dot, pc.url.replace(/^https?:\/\//, ''))),
    el('button', { class: 'icon-btn', 'aria-label': 'Удалить', onclick: (e) => {
      e.stopPropagation();
      savePcs(loadPcs().filter((p) => p.url !== pc.url));
      render();
    } }, Icons.el('trash', 18)));
    hello(pc.url, 3000).then((ok) => { dot.className = 'dot ' + (ok ? 'on' : 'off'); });
    return row;
  }));
}

// ---------------- сканер ----------------
let stream = null;
let scanning = false;

async function startScan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    toast('Нет доступа к камере. Разрешите камеру в настройках Android или введите адрес вручную.');
    return;
  }
  $('#scanner').classList.remove('hidden');
  const video = $('#video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  scanning = true;
  const canvas = $('#canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (!scanning) return;
    if (video.readyState >= 2) {
      const w = 480;
      const h = Math.round((video.videoHeight / video.videoWidth) * w) || 360;
      canvas.width = w; canvas.height = h;
      g.drawImage(video, 0, 0, w, h);
      const code = jsQR(g.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        const handled = await onQr(code.data);
        if (handled) return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopScan() {
  scanning = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('#scanner').classList.add('hidden');
}

let lastQr = '';
async function onQr(text) {
  if (text === lastQr) return false;
  lastQr = text;
  setTimeout(() => { lastQr = ''; }, 3000);
  let u;
  try { u = new URL(text); } catch (e) { toast('Это не QR-код PC Full Control'); return false; }
  const m = u.hash.match(/#\/pair\/(\d{6})/);
  if (!/^https?:$/.test(u.protocol) || !m) { toast('Это не QR-код PC Full Control'); return false; }
  if (navigator.vibrate) navigator.vibrate(30);
  stopScan();
  const base = normalizeAddress(u.origin);
  toast('Подключаюсь…');
  await addPc(base, `#/pair/${m[1]}`);
  return true;
}

$('#scan').addEventListener('click', startScan);
$('#scan-close').addEventListener('click', stopScan);

// ---------------- ручной ввод ----------------
$('#manual').addEventListener('click', () => {
  $('#manual-sheet').classList.remove('hidden');
  $('#addr-error').textContent = '';
  setTimeout(() => $('#addr').focus(), 200);
});
$('#addr-cancel').addEventListener('click', () => $('#manual-sheet').classList.add('hidden'));
$('#addr-ok').addEventListener('click', async () => {
  const base = normalizeAddress($('#addr').value);
  if (!base) { $('#addr-error').textContent = 'Введите адрес, например 192.168.1.5:8765'; return; }
  $('#addr-ok').disabled = true;
  $('#addr-error').textContent = '';
  const ok = await addPc(base);
  $('#addr-ok').disabled = false;
  if (!ok) $('#addr-error').textContent = 'Не удалось подключиться к этому адресу';
});

// ---------------- старт ----------------
Icons.hydrate();
render();
// Автоматически открываем последний компьютер, если не пришли сюда кнопкой «Другой компьютер»
(async () => {
  const fromSwitch = /list=1/.test(location.search) || document.referrer;
  const last = localStorage.getItem('pcfc_last');
  if (!fromSwitch && last && loadPcs().some((p) => p.url === last) && await hello(last, 2500)) openPc(last);
})();
