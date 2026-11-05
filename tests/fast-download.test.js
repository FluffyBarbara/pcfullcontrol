'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { download, CHUNK } = require('../src/main/fast-download');

function server(data, { ranges = true, failOnce = false } = {}) {
  let failed = false;
  let active = 0;
  const stat = { maxActive: 0, requests: 0 };
  const srv = http.createServer((req, res) => {
    stat.requests++;
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!ranges || !m) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), data.length - 1);
    res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${data.length}` });
    // Один раз обрываем кусок на середине — загрузчик должен докачать его заново
    if (failOnce && !failed && start > 0) { failed = true; res.write(data.subarray(start, start + 1000)); res.destroy(); return; }
    active++;
    stat.maxActive = Math.max(stat.maxActive, active);
    setTimeout(() => { res.end(data.subarray(start, end + 1)); active--; }, 30);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, stat, url: `http://127.0.0.1:${srv.address().port}/f.exe` })));
}

test('быстрая загрузка: несколько соединений, докачка оборванного куска, проверка SHA-512', async () => {
  const data = crypto.randomBytes(CHUNK * 3 + 12345);
  const sha512 = crypto.createHash('sha512').update(data).digest('base64');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcfc-fd-'));
  const { srv, stat, url } = await server(data, { failOnce: true });
  let last = null;
  const r = await download(url, path.join(dir, 'a.exe'), { sha512, size: data.length, connections: 8, onProgress: (p) => { last = p; } });
  assert.equal(r.total, data.length);
  assert.ok(fs.readFileSync(path.join(dir, 'a.exe')).equals(data), 'файл собран без ошибок');
  assert.ok(stat.maxActive >= 3, `качалось параллельно (${stat.maxActive} соединений)`);
  assert.equal(Math.round(last.percent), 100);
  await assert.rejects(() => download(url, path.join(dir, 'b.exe'), { sha512: 'неверная', connections: 4 }), /sha512/);
  srv.close();
  const s2 = await server(data, { ranges: false });
  await assert.rejects(() => download(s2.url, path.join(dir, 'c.exe'), {}), (e) => e.code === 'NO_RANGES');
  s2.srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
