'use strict';
// Подпись запросов телефона к ПК. Сам ключ доступа по сети не передаётся: телефон подписывает
// каждый запрос (метод, адрес, время, одноразовое число) ключом HMAC-SHA256. Подслушавший Wi-Fi
// видит только подпись одного запроса — повторить её или подписать другой запрос он не может.
// Свой SHA-256: на телефоне сайт открыт по http://, а там браузер не даёт встроенную криптографию.
(function (root) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

  function utf8(s) {
    if (s instanceof Uint8Array) return s;
    if (s instanceof ArrayBuffer) return new Uint8Array(s);
    if (ArrayBuffer.isView(s)) return new Uint8Array(s.buffer, s.byteOffset, s.byteLength);
    return new TextEncoder().encode(String(s));
  }

  function sha256(data) {
    const m = utf8(data);
    const len = m.length;
    const withPad = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(withPad);
    buf.set(m);
    buf[len] = 0x80;
    const bits = len * 8;
    const dv = new DataView(buf.buffer);
    dv.setUint32(withPad - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(withPad - 4, bits >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < withPad; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15]; const b = w[i - 2];
        const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
        const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
    return out;
  }

  const hex = (u8) => Array.from(u8, (x) => x.toString(16).padStart(2, '0')).join('');
  const fromHex = (s) => new Uint8Array((String(s).match(/../g) || []).map((x) => parseInt(x, 16)));

  function hmac(key, msg) {
    let k = utf8(key);
    if (k.length > 64) k = sha256(k);
    const ipad = new Uint8Array(64 + 0); const opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) { ipad[i] = (k[i] || 0) ^ 0x36; opad[i] = (k[i] || 0) ^ 0x5c; }
    const m = utf8(msg);
    const inner = new Uint8Array(64 + m.length); inner.set(ipad); inner.set(m, 64);
    const ih = sha256(inner);
    const outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
    return sha256(outer);
  }

  /** Ключ подписи телефона: SHA-256 от его токена (сам токен остаётся только в телефоне). */
  const signKey = (token) => hex(sha256(token));
  /** Короткий номер устройства для поиска ключа на ПК (не раскрывает ключ). */
  const deviceId = (key) => hex(sha256('id:' + key)).slice(0, 16);
  const message = (method, url, ts, nonce) => `${String(method).toUpperCase()}\n${url}\n${ts}\n${nonce}`;

  /** Заголовок X-PCFC-Auth: «номер.время.одноразовое.подпись». */
  function authHeader(token, method, url, now = Date.now(), nonce = null) {
    const key = signKey(token);
    const n = nonce || hex(randomBytes(12));
    return `${deviceId(key)}.${now}.${n}.${hex(hmac(key, message(method, url, now, n)))}`;
  }

  function randomBytes(n) {
    const a = new Uint8Array(n);
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) ? globalThis.crypto : null;
    if (c) c.getRandomValues(a); else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    return a;
  }

  /** Расшифровка токена при привязке: XOR с потоком HMAC(секрет из QR-кода, соль, номер блока). */
  function unseal(secret, salt, sealedHex) {
    const data = fromHex(sealedHex);
    const out = new Uint8Array(data.length);
    for (let off = 0, blk = 0; off < data.length; off += 32, blk++) {
      const ks = hmac(secret, `${salt}:${blk}`);
      for (let i = 0; i < 32 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return new TextDecoder().decode(out);
  }
  const seal = (secret, salt, text) => {
    const data = utf8(text);
    const out = new Uint8Array(data.length);
    for (let off = 0, blk = 0; off < data.length; off += 32, blk++) {
      const ks = hmac(secret, `${salt}:${blk}`);
      for (let i = 0; i < 32 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
    }
    return hex(out);
  };

  // ---------------- шифрование содержимого (ChaCha20 + HMAC-SHA256) ----------------
  // Все данные между телефоном и ПК шифруются ключом телефона: подслушавший Wi-Fi видит только шум,
  // а подменить ответ (например, данные для трансляции экрана) нельзя — проверяется код HMAC.
  function chacha20(key, nonce, data, counter = 0) {
    const k = new DataView(key.buffer, key.byteOffset, 32);
    const n = new DataView(nonce.buffer, nonce.byteOffset, 12);
    const st = new Uint32Array(16);
    const x = new Uint32Array(16);
    const out = new Uint8Array(data.length);
    const blk = new Uint8Array(64);
    const bv = new DataView(blk.buffer);
    const rot = (v, c) => (v << c) | (v >>> (32 - c));
    const qr = (a, b, c, d) => {
      x[a] = (x[a] + x[b]) >>> 0; x[d] = rot(x[d] ^ x[a], 16);
      x[c] = (x[c] + x[d]) >>> 0; x[b] = rot(x[b] ^ x[c], 12);
      x[a] = (x[a] + x[b]) >>> 0; x[d] = rot(x[d] ^ x[a], 8);
      x[c] = (x[c] + x[d]) >>> 0; x[b] = rot(x[b] ^ x[c], 7);
    };
    st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
    for (let i = 0; i < 8; i++) st[4 + i] = k.getUint32(i * 4, true);
    st[12] = counter >>> 0;
    for (let i = 0; i < 3; i++) st[13 + i] = n.getUint32(i * 4, true);
    for (let off = 0; off < data.length; off += 64) {
      x.set(st);
      for (let i = 0; i < 10; i++) {
        qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
        qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
      }
      for (let i = 0; i < 16; i++) bv.setUint32(i * 4, (x[i] + st[i]) >>> 0, true);
      const lim = Math.min(64, data.length - off);
      for (let i = 0; i < lim; i++) out[off + i] = data[off + i] ^ blk[i];
      st[12] = (st[12] + 1) >>> 0;
    }
    return out;
  }

  function concat(...parts) {
    const len = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function keys(key, dir, nonce) {
    return { enc: hmac(key, 'pcfc-enc'), mac: hmac(key, 'pcfc-mac'), iv: hmac(key, `iv:${dir}:${nonce}`).slice(0, 12), head: utf8(`${dir}:${nonce}:`) };
  }
  /** Шифрует данные запроса (dir='req') или ответа (dir='res'); к результату дописан код проверки (32 байта). */
  function encrypt(key, dir, nonce, data) {
    const kk = keys(key, dir, nonce);
    const ct = chacha20(kk.enc, kk.iv, utf8(data));
    return concat(ct, hmac(kk.mac, concat(kk.head, ct)));
  }
  /** Расшифровка; при подмене данных — ошибка. */
  function decrypt(key, dir, nonce, box) {
    const b = utf8(box);
    if (b.length < 32) throw new Error('повреждённые данные');
    const kk = keys(key, dir, nonce);
    const ct = b.subarray(0, b.length - 32);
    const want = hmac(kk.mac, concat(kk.head, ct));
    let diff = 0;
    for (let i = 0; i < 32; i++) diff |= want[i] ^ b[b.length - 32 + i];
    if (diff) throw new Error('данные подменены или повреждены');
    return chacha20(kk.enc, kk.iv, ct);
  }

  /** Подписанный запрос с шифрованием: { header, key, nonce } (флаг шифрования входит в подпись). */
  function signed(token, method, url, now = Date.now(), enc = true) {
    const key = signKey(token);
    const n = hex(randomBytes(12));
    const msg = message(method, url, now, n) + (enc ? '\nE' : '');
    return { header: `${deviceId(key)}.${now}.${n}.${hex(hmac(key, msg))}`, key, nonce: n };
  }

  // ---------------- X25519 (обмен ключами при привязке по коду) ----------------
  // По мотивам TweetNaCl (общественное достояние): общий секрет вычисляют телефон и ПК, по сети он не идёт.
  const gf = (init) => { const r = new Float64Array(16); if (init) for (let i = 0; i < init.length; i++) r[i] = init[i]; return r; };
  const _121665 = gf([0xdb41, 1]);
  function car25519(o) { for (let i = 0; i < 16; i++) { o[i] += 65536; const c = Math.floor(o[i] / 65536); o[(i + 1) * (i < 15 ? 1 : 0)] += c - 1 + 37 * (c - 1) * (i === 15 ? 1 : 0); o[i] -= c * 65536; } }
  function sel25519(p, q, b) { const c = ~(b - 1); for (let i = 0; i < 16; i++) { const t = c & (p[i] ^ q[i]); p[i] ^= t; q[i] ^= t; } }
  function pack25519(o, n) {
    const m = gf(); const t = gf();
    for (let i = 0; i < 16; i++) t[i] = n[i];
    car25519(t); car25519(t); car25519(t);
    for (let j = 0; j < 2; j++) {
      m[0] = t[0] - 0xffed;
      for (let i = 1; i < 15; i++) { m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1); m[i - 1] &= 0xffff; }
      m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
      const b = (m[15] >> 16) & 1;
      m[14] &= 0xffff;
      sel25519(t, m, 1 - b);
    }
    for (let i = 0; i < 16; i++) { o[2 * i] = t[i] & 0xff; o[2 * i + 1] = t[i] >> 8; }
  }
  function unpack25519(o, n) { for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8); o[15] &= 0x7fff; }
  const A = (o, a, b) => { for (let i = 0; i < 16; i++) o[i] = a[i] + b[i]; };
  const Z = (o, a, b) => { for (let i = 0; i < 16; i++) o[i] = a[i] - b[i]; };
  function M(o, a, b) {
    const t = new Float64Array(31);
    for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
    for (let i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
    for (let i = 0; i < 16; i++) o[i] = t[i];
    car25519(o); car25519(o);
  }
  const S = (o, a) => M(o, a, a);
  function inv25519(o, i) { const c = gf(); for (let a = 0; a < 16; a++) c[a] = i[a]; for (let a = 253; a >= 0; a--) { S(c, c); if (a !== 2 && a !== 4) M(c, c, i); } for (let a = 0; a < 16; a++) o[a] = c[a]; }
  function scalarmult(n, p) {
    const z = new Uint8Array(32); const x = new Float64Array(80);
    const a = gf(); const b = gf(); const c = gf(); const d = gf(); const e = gf(); const f = gf();
    for (let i = 0; i < 31; i++) z[i] = n[i];
    z[31] = (n[31] & 127) | 64; z[0] &= 248;
    unpack25519(x, p);
    for (let i = 0; i < 16; i++) { b[i] = x[i]; d[i] = a[i] = c[i] = 0; }
    a[0] = d[0] = 1;
    for (let i = 254; i >= 0; --i) {
      const r = (z[i >>> 3] >>> (i & 7)) & 1;
      sel25519(a, b, r); sel25519(c, d, r);
      A(e, a, c); Z(a, a, c); A(c, b, d); Z(b, b, d); S(d, e); S(f, a); M(a, c, a); M(c, b, e);
      A(e, a, c); Z(a, a, c); S(b, a); Z(c, d, f); M(a, c, _121665); A(a, a, d); M(c, c, a); M(a, d, f); M(d, b, x); S(b, e);
      sel25519(a, b, r); sel25519(c, d, r);
    }
    for (let i = 0; i < 16; i++) { x[i + 16] = a[i]; x[i + 32] = c[i]; x[i + 48] = b[i]; x[i + 64] = d[i]; }
    const x32 = x.subarray(32); const x16 = x.subarray(16);
    inv25519(x32, x32); M(x16, x16, x32);
    const q = new Uint8Array(32); pack25519(q, x16);
    return q;
  }
  const BASE = new Uint8Array(32); BASE[0] = 9;
  /** Новая пара ключей: { priv, pub } (по 32 байта). */
  function x25519Keys() { const priv = randomBytes(32); return { priv, pub: scalarmult(priv, BASE) }; }
  const x25519 = (priv, pub) => scalarmult(priv, pub);

  const api = { sha256, hmac, hex, fromHex, signKey, deviceId, message, authHeader, seal, unseal, chacha20, encrypt, decrypt, signed, x25519Keys, x25519, randomBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PcfcSig = api;
}(typeof self !== 'undefined' ? self : this));
