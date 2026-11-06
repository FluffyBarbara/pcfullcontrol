'use strict';
// Отдельный процесс: обход диска (размеры папок, самые большие файлы) и поиск дубликатов.
// Ничего не удаляет и не меняет — только читает. Работает и как utilityProcess Electron, и как child_process.fork.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = process.parentPort || null;
const send = (m) => (port ? port.postMessage(m) : process.send && process.send(m));
const onMessage = (fn) => (port ? port.on('message', (e) => fn(e.data)) : process.on('message', fn));

const MIN_DUP = 1024 * 1024; // дубликаты ищем среди файлов от 1 МБ
const BIG_SAMPLE = 256 * 1024 * 1024; // крупнее — сравниваем по выборке из 4 кусков по 1 МБ
const TOP = 300;
const SKIP_DIRS = /^(System Volume Information|\$Recycle\.Bin|\$WinREAgent|Config\.Msi|\$SysReset|\$Windows\.~BT|\$Windows\.~WS|Recovery)$/i;

let cancel = false;

async function walk(root, progress) {
  const dirs = new Map(); // путь → { size, files, parent }
  const top = [];
  const dupCand = new Map(); // размер → [пути]
  let files = 0;
  let bytes = 0;
  let lastSend = 0;
  const queue = [root];
  dirs.set(root, { size: 0, files: 0, own: 0, parent: null, kids: [] });
  const workers = 16;
  async function one(dir) {
    let h;
    try { h = await fs.promises.opendir(dir, { bufferSize: 256 }); } catch (e) { return; }
    const node = dirs.get(dir);
    try {
      for await (const ent of h) {
        if (cancel) return;
        const p = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) {
          if (dir === root && SKIP_DIRS.test(ent.name)) continue;
          dirs.set(p, { size: 0, files: 0, own: 0, parent: dir, kids: [] });
          node.kids.push(p);
          queue.push(p);
        } else if (ent.isFile()) {
          let st;
          try { st = await fs.promises.lstat(p); } catch (e) { continue; }
          const size = st.size;
          files++; bytes += size;
          node.own += size; node.files++;
          if (size >= MIN_DUP) { let a = dupCand.get(size); if (!a) { a = []; dupCand.set(size, a); } a.push(p); }
          if (top.length < TOP || size > top[top.length - 1].size) {
            top.push({ path: p, size, mtime: st.mtimeMs });
            if (top.length > TOP * 2) { top.sort((a, b) => b.size - a.size); top.length = TOP; }
          }
          const now = Date.now();
          if (now - lastSend > 400) { lastSend = now; progress({ files, bytes, dirs: dirs.size, current: dir }); }
        }
      }
    } catch (e) { /* папка исчезла или нет доступа */ }
  }
  async function loop() {
    while (queue.length && !cancel) await one(queue.pop());
  }
  // Несколько «обходчиков» параллельно: пока один ждёт диск, другой работает
  for (;;) {
    await Promise.all(Array.from({ length: workers }, loop));
    if (!queue.length || cancel) break;
  }
  // Размеры папок снизу вверх
  const order = [...dirs.keys()].sort((a, b) => b.length - a.length);
  for (const k of order) {
    const n = dirs.get(k);
    n.size += n.own;
    n.files += 0;
    if (n.parent && dirs.has(n.parent)) { const par = dirs.get(n.parent); par.size += n.size; }
  }
  top.sort((a, b) => b.size - a.size);
  top.length = Math.min(top.length, TOP);
  return { dirs, top, dupCand, files, bytes };
}

async function hashFile(p, size) {
  const h = crypto.createHash('sha1');
  if (size <= BIG_SAMPLE) {
    await new Promise((res, rej) => fs.createReadStream(p, { highWaterMark: 1 << 20 }).on('data', (d) => { if (cancel) rej(new Error('cancel')); else h.update(d); }).on('end', res).on('error', rej));
    return { hash: h.digest('hex'), exact: true };
  }
  const fd = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (const pos of [0, Math.floor(size / 3), Math.floor((size * 2) / 3), size - buf.length]) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, Math.max(0, pos));
      h.update(buf.subarray(0, bytesRead));
    }
  } finally { await fd.close(); }
  return { hash: h.digest('hex'), exact: false };
}

async function partial(p) {
  const fd = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    return crypto.createHash('sha1').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally { await fd.close(); }
}

async function duplicates(dupCand, progress) {
  const groups = [...dupCand.entries()].filter(([, a]) => a.length > 1).sort((a, b) => b[0] - a[0]);
  const total = groups.reduce((s, [size, a]) => s + size * a.length, 0);
  let done = 0;
  const out = [];
  for (const [size, paths] of groups) {
    if (cancel) break;
    const byPart = new Map();
    for (const p of paths) {
      try { const k = await partial(p); if (!byPart.has(k)) byPart.set(k, []); byPart.get(k).push(p); } catch (e) { /* занят */ }
    }
    for (const same of byPart.values()) {
      if (same.length < 2) continue;
      const byFull = new Map();
      let exact = true;
      for (const p of same) {
        try {
          const r = await hashFile(p, size);
          exact = exact && r.exact;
          if (!byFull.has(r.hash)) byFull.set(r.hash, []);
          byFull.get(r.hash).push(p);
        } catch (e) { /* занят */ }
        done += size;
        progress({ hashed: done, hashTotal: total });
      }
      for (const [hash, list] of byFull) if (list.length > 1) out.push({ size, hash, exact, files: list, wasted: size * (list.length - 1) });
    }
  }
  out.sort((a, b) => b.wasted - a.wasted);
  return out.slice(0, 300);
}

onMessage(async (m) => {
  if (!m) return;
  if (m.type === 'cancel') { cancel = true; return; }
  if (m.type !== 'scan') return;
  cancel = false;
  try {
    const t0 = Date.now();
    const w = await walk(m.root, (p) => send({ type: 'progress', phase: 'scan', ...p }));
    let dups = [];
    if (m.dups !== false && !cancel) dups = await duplicates(w.dupCand, (p) => send({ type: 'progress', phase: 'dups', files: w.files, bytes: w.bytes, ...p }));
    // Дерево папок (для карты места): плоский список с размерами
    const tree = [];
    for (const [p, n] of w.dirs) tree.push([p, n.size, n.files, n.parent]);
    send({ type: 'done', cancelled: cancel, root: m.root, files: w.files, bytes: w.bytes, top: w.top, dups, tree, ms: Date.now() - t0 });
  } catch (e) {
    send({ type: 'error', error: e.message });
  }
});
