'use strict';
// Быстрое скачивание обновления: файл качается кусками в несколько соединений одновременно
// (как в менеджерах загрузок). У GitHub скорость одного соединения часто сильно ограничена —
// несколько параллельных дают в разы больше. В конце файл проверяется по контрольной сумме SHA-512.
const fs = require('fs');
const crypto = require('crypto');

const CHUNK = 4 * 1024 * 1024;
const STALL_MS = 20000;
const RETRIES = 6;

/** Узнаёт конечный адрес файла (GitHub отдаёт его через перенаправление) и размер. */
async function resolve(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  const total = Number(((r.headers.get('content-range') || '').split('/')[1]) || 0);
  try { await r.body?.cancel(); } catch (e) { /* ignore */ }
  if (r.status !== 206 || !total) return { url: r.url || url, total: 0, ranges: false };
  return { url: r.url || url, total, ranges: true };
}

async function sha512File(file) {
  const h = crypto.createHash('sha512');
  await new Promise((res, rej) => fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', res).on('error', rej));
  return h.digest('base64');
}

/**
 * Скачивает url в dest. onProgress({ transferred, total, speed }).
 * Возвращает { total, connections }. Если сервер не умеет отдавать файл частями — бросает ошибку
 * с кодом NO_RANGES (тогда используется обычная загрузка).
 */
async function download(url, dest, { sha512 = null, size = 0, connections = 8, onProgress = () => {}, fetchImpl = fetch, log = () => {} } = {}) {
  let info = await resolve(url, fetchImpl);
  if (!info.ranges) { const e = new Error('Сервер не поддерживает загрузку частями'); e.code = 'NO_RANGES'; throw e; }
  const total = info.total;
  if (size && size !== total) throw new Error(`Размер файла не совпадает (${total} вместо ${size})`);
  const chunks = [];
  for (let start = 0; start < total; start += CHUNK) chunks.push({ start, end: Math.min(total, start + CHUNK) - 1, tries: 0 });
  const fh = await fs.promises.open(dest, 'w');
  let transferred = 0;
  const samples = [];
  let lastEmit = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastEmit < 300) return;
    lastEmit = now;
    samples.push([now, transferred]);
    while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
    const [t0, b0] = samples[0];
    const speed = now > t0 ? ((transferred - b0) * 1000) / (now - t0) : 0;
    onProgress({ transferred, total, percent: (transferred / total) * 100, speed });
  };
  let reresolving = null;
  const reresolve = () => {
    if (!reresolving) reresolving = resolve(url, fetchImpl).then((i) => { if (i.ranges) info = i; }).finally(() => { reresolving = null; });
    return reresolving;
  };

  async function fetchChunk(c) {
    let got = 0;
    const ac = new AbortController();
    let stall = setTimeout(() => ac.abort(), STALL_MS);
    try {
      const r = await fetchImpl(info.url, { headers: { Range: `bytes=${c.start}-${c.end}` }, signal: ac.signal });
      if (r.status === 403 || r.status === 410) { await reresolve(); throw new Error(`ссылка устарела (${r.status})`); }
      if (r.status !== 206) throw new Error(`ответ ${r.status}`);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(stall);
        stall = setTimeout(() => ac.abort(), STALL_MS);
        if (got + value.length > c.end - c.start + 1) throw new Error('лишние данные');
        await fh.write(value, 0, value.length, c.start + got);
        got += value.length;
        transferred += value.length;
        emit(false);
      }
      if (got !== c.end - c.start + 1) throw new Error('кусок оборвался');
    } catch (e) {
      transferred -= got;
      throw e;
    } finally {
      clearTimeout(stall);
    }
  }

  let next = 0;
  let failed = null;
  async function worker() {
    while (!failed && next < chunks.length) {
      const c = chunks[next++];
      for (;;) {
        try { await fetchChunk(c); break; } catch (e) {
          c.tries++;
          if (c.tries > RETRIES) { failed = e; return; }
          log(`кусок ${c.start}: ${e.message} — повтор ${c.tries}`);
          await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** c.tries)));
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(connections, chunks.length) }, worker));
  } finally {
    await fh.close();
  }
  if (failed) throw failed;
  emit(true);
  if (sha512) {
    const got = await sha512File(dest);
    if (got !== sha512) throw new Error('sha512 checksum mismatch');
  }
  return { total, connections };
}

module.exports = { download, sha512File, CHUNK };
