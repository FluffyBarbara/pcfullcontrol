'use strict';
// Мини-сервер обновлений для проверки в CI: раздаёт latest.yml и установщик из папки.
const fs = require('fs');
const http = require('http');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(dir, path.basename(name));
  console.log(new Date().toISOString(), req.method, req.url);
  if (!name || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const st = fs.statSync(file);
  res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(9999, '127.0.0.1', () => console.log('feed on 9999 from', dir));
