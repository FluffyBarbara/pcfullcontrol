'use strict';
// Голосовой ассистент Android-приложения: запись с микрофона (эта страница — локальная, поэтому микрофон
// доступен), распознавание и выполнение — на ПК, ответ — на экране и голосом.
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1));
const PC = params.get('pc') || '';
const TOKEN = params.get('t') || '';
const BACK = params.get('back') || PC;
let rec = null;
let chunks = [];
let stopTimer = null;
let lastHeard = '';

function plugin() { const C = window.Capacitor; return C && C.Plugins && C.Plugins.PcControl; }
function say(text) {
  const p = plugin();
  if (p) { p.speak({ text }).catch(() => {}); return; }
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'ru-RU'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* нет озвучки */ }
}
function status(t) { $('#v-status').textContent = t; }
function bubble(id, text) { const b = $(id); b.textContent = text; b.classList.toggle('hidden', !text); }

async function post(path, body, type) {
  const r = await fetch(PC + path, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': type || 'application/json' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Ошибка ' + r.status);
  return j;
}

function showResult(r) {
  lastHeard = r.heard || '';
  bubble('#v-heard', lastHeard ? `«${lastHeard}»` : '');
  bubble('#v-reply', r.reply || '');
  $('#v-confirm').classList.toggle('hidden', !r.needConfirm);
  status(r.needConfirm ? 'Подтвердите действие' : 'Нажмите, чтобы сказать ещё');
  if (r.reply) say(r.reply);
}

async function start() {
  if (rec) { stop(); return; }
  bubble('#v-heard', ''); bubble('#v-reply', ''); $('#v-confirm').classList.add('hidden');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { status('Нет доступа к микрофону — разрешите его в настройках приложения'); return; }
  chunks = [];
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
    rec = null;
    $('#v-mic').classList.remove('rec');
    if (blob.size < 2000) { status('Слишком коротко — попробуйте ещё раз'); return; }
    $('#v-mic').classList.add('busy');
    status('Распознаю на компьютере…');
    try { showResult(await post('/api/assistant/audio', blob, blob.type)); } catch (e) { status(e.message); }
    $('#v-mic').classList.remove('busy');
  };
  rec.start();
  if (navigator.vibrate) navigator.vibrate(20);
  $('#v-mic').classList.add('rec');
  status('Слушаю… нажмите, когда закончите');
  clearTimeout(stopTimer);
  stopTimer = setTimeout(stop, 12000);
}

function stop() {
  clearTimeout(stopTimer);
  if (rec && rec.state === 'recording') rec.stop();
}

$('#v-mic').addEventListener('click', start);
$('#v-yes').addEventListener('click', async () => {
  $('#v-confirm').classList.add('hidden');
  status('Выполняю…');
  try { showResult(await post('/api/assistant', JSON.stringify({ text: lastHeard, confirm: true }))); } catch (e) { status(e.message); }
});
$('#v-no').addEventListener('click', () => { $('#v-confirm').classList.add('hidden'); bubble('#v-reply', 'Отменено.'); status('Нажмите, чтобы сказать ещё'); });
$('#v-back').addEventListener('click', () => { location.href = BACK; });
$('#v-pc').textContent = PC.replace(/^https?:\/\//, '');
if (window.Icons) Icons.hydrate();
if (!PC || !TOKEN) status('Откройте ассистента из приложения на телефоне');
else start();
