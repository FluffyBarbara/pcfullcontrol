'use strict';
// Обновление «по разнице»: из нового установщика скачиваются только изменившиеся куски, остальное
// берётся из установщика текущей версии, сохранённого на диске. Какие куски одинаковые — показывают
// карты блоков (.blockmap), которые публикуются вместе с каждым релизом. Итог проверяется по SHA-512.
const fs = require('fs');
const zlib = require('zlib');
const { sha512File, CHUNK } = require('./fast-download');

function parseBlockmap(buf) {
  const json = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  const f = (json.files || [])[0];
  if (!f || !Array.isArray(f.checksums) || f.checksums.length !== f.sizes.length) throw new Error('неверная карта блоков');
  return f;
}

/** Первая доступная карта блоков из списка адресов → { buf, map }. */
async function fetchBlockmap(urls, fetchImpl = fetch) {
  let last = null;
  for (const url of [].concat(urls)) {
    try {
      const r = await fetchImpl(url, { redirect: 'follow' });
      if (!r.ok) { last = new Error(`карта блоков недоступна (${r.status})`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      return { buf, map: parseBlockmap(buf) };
    } catch (e) { last = e; }
  }
  throw last || new Error('карта блоков недоступна');
}

/**
 * План сборки нового файла: какие диапазоны скопировать из старого, какие скачать.
 * → { ops: [{ kind: 'copy'|'download', from, to, size }], download, total }
 */
function plan(oldMap, newMap) {
  const have = new Map();
  let off = oldMap.offset || 0;
  oldMap.checksums.forEach((c, i) => { const k = `${c}:${oldMap.sizes[i]}`; if (!have.has(k)) have.set(k, off); off += oldMap.sizes[i]; });
  const ops = [];
  let pos = newMap.offset || 0;
  let download = 0;
  newMap.checksums.forEach((c, i) => {
    const size = newMap.sizes[i];
    const from = have.get(`${c}:${size}`);
    const kind = from === undefined ? 'download' : 'copy';
    const last = ops[ops.length - 1];
    // Соседние куски одного вида склеиваем в один диапазон
    if (last && last.kind === kind && last.to + last.size === pos && (kind === 'download' || last.from + last.size === from)) last.size += size;
    else ops.push({ kind, from: kind === 'copy' ? from : pos, to: pos, size });
    if (kind === 'download') download += size;
    pos += size;
  });
  return { ops, download, total: pos };
}

/**
 * Собирает новый установщик в dest. oldFile — установщик текущей версии.
 * onProgress({ transferred, total, percent, speed }) — по скачанным байтам.
 */
async function differential({ url, oldFile, oldBlockmap = null, oldBlockmapUrl, newBlockmapUrl, dest, sha512, size = 0, connections = 6, fetchImpl = fetch, onProgress = () => {}, log = () => {} }) {
  // Карта блоков старой версии — сохранённая рядом с установщиком, иначе из релиза
  const oldMap = oldBlockmap ? parseBlockmap(oldBlockmap) : (await fetchBlockmap(oldBlockmapUrl, fetchImpl)).map;
  const fresh = await fetchBlockmap(newBlockmapUrl, fetchImpl);
  const newMap = fresh.map;
  const p = plan(oldMap, newMap);
  if (size && p.total !== size) throw new Error('карта блоков не совпадает с размером файла');
  const oldSize = fs.statSync(oldFile).size;
  if (oldMap.sizes.reduce((s, x) => s + x, oldMap.offset || 0) !== oldSize) throw new Error('сохранённый установщик не совпадает с картой блоков');
  log(`по разнице: скачать ${(p.download / 1e6).toFixed(1)} МБ из ${(p.total / 1e6).toFixed(1)} МБ`);

  // Конечный адрес файла (GitHub отдаёт через перенаправление) — один раз
  const head = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
  try { await head.body?.cancel(); } catch (e) { /* ignore */ }
  if (head.status !== 206) throw new Error('сервер не отдаёт файл частями');
  const finalUrl = head.url || url;

  const out = await fs.promises.open(dest, 'w');
  const old = await fs.promises.open(oldFile, 'r');
  let transferred = 0;
  const t0 = Date.now();
  const emit = () => onProgress({ transferred, total: p.download, percent: p.download ? (transferred / p.download) * 100 : 100, speed: transferred / Math.max(0.001, (Date.now() - t0) / 1000) });
  try {
    // 1) Копирование из старого файла
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (const op of p.ops) {
      if (op.kind !== 'copy') continue;
      for (let done = 0; done < op.size;) {
        const n = Math.min(buf.length, op.size - done);
        const { bytesRead } = await old.read(buf, 0, n, op.from + done);
        if (bytesRead !== n) throw new Error('сохранённый установщик повреждён');
        await out.write(buf, 0, n, op.to + done);
        done += n;
      }
    }
    // 2) Скачивание изменившихся кусков — параллельно, крупные диапазоны делим
    const jobs = [];
    for (const op of p.ops) {
      if (op.kind !== 'download') continue;
      for (let s = 0; s < op.size; s += CHUNK) jobs.push({ start: op.to + s, end: op.to + Math.min(op.size, s + CHUNK) - 1, tries: 0 });
    }
    let next = 0;
    let failed = null;
    const worker = async () => {
      while (!failed && next < jobs.length) {
        const j = jobs[next++];
        for (;;) {
          try {
            const r = await fetchImpl(finalUrl, { headers: { Range: `bytes=${j.start}-${j.end}` } });
            if (r.status !== 206) throw new Error(`ответ ${r.status}`);
            const data = Buffer.from(await r.arrayBuffer());
            if (data.length !== j.end - j.start + 1) throw new Error('кусок оборвался');
            await out.write(data, 0, data.length, j.start);
            transferred += data.length;
            emit();
            break;
          } catch (e) {
            if (++j.tries > 5) { failed = e; return; }
            log(`кусок ${j.start}: ${e.message} — повтор`);
            await new Promise((res) => setTimeout(res, 500 * 2 ** j.tries));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(connections, jobs.length)) }, worker));
    if (failed) throw failed;
  } finally {
    await out.close();
    await old.close();
  }
  emit();
  if (sha512 && (await sha512File(dest)) !== sha512) throw new Error('sha512 checksum mismatch');
  return { downloaded: p.download, total: p.total, blockmap: fresh.buf };
}

module.exports = { differential, plan, fetchBlockmap, parseBlockmap };
