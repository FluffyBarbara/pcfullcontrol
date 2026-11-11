'use strict';
// Своя криптография (src/shared/sig.js) против официальных тест-векторов и эталона Node.
// Нужна потому, что телефон открывает страницу по http:// — там браузер не даёт встроенную криптографию.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Sig = require('../src/shared/sig');

const hex = (u8) => Buffer.from(u8).toString('hex');
const unhex = (s) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ''), 'hex'));

test('SHA-256: тест-векторы FIPS 180-4', () => {
  assert.equal(hex(Sig.sha256('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(Sig.sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(Sig.sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  assert.equal(hex(Sig.sha256('a'.repeat(1000000))), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

test('HMAC-SHA256: тест-векторы RFC 4231', () => {
  assert.equal(hex(Sig.hmac(unhex('0b'.repeat(20)), 'Hi There')), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(hex(Sig.hmac('Jefe', 'what do ya want for nothing?')), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  assert.equal(hex(Sig.hmac(unhex('aa'.repeat(20)), unhex('dd'.repeat(50)))), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe');
  assert.equal(hex(Sig.hmac(unhex('aa'.repeat(131)), 'Test Using Larger Than Block-Size Key - Hash Key First')), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
});

test('ChaCha20: тест-вектор RFC 8439 (раздел 2.4.2)', () => {
  const key = unhex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
  const nonce = unhex('000000000000004a00000000');
  const text = "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
  const want = `6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0bf91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8
    07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab77937365af90bbf74a35be6b40b8eedf2785e42874d`;
  assert.equal(hex(Sig.chacha20(key, nonce, new TextEncoder().encode(text), 1)), want.replace(/\s+/g, ''));
});

test('X25519: тест-векторы RFC 7748 (разделы 5.2 и 6.1)', () => {
  assert.equal(hex(Sig.x25519(unhex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4'), unhex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c'))),
    'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552');
  const base = new Uint8Array(32); base[0] = 9;
  const alice = unhex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bob = unhex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  const alicePub = Sig.x25519(alice, base);
  const bobPub = Sig.x25519(bob, base);
  assert.equal(hex(alicePub), '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  assert.equal(hex(bobPub), 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
  const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
  assert.equal(hex(Sig.x25519(alice, bobPub)), shared);
  assert.equal(hex(Sig.x25519(bob, alicePub)), shared);
});

test('случайные сверки с эталоном Node: 300 входов разной длины', () => {
  const hasChacha = crypto.getCiphers().includes('chacha20'); // в Electron (BoringSSL) его нет
  for (let i = 0; i < 300; i++) {
    const len = i < 130 ? i : crypto.randomInt(0, 5000);
    const data = crypto.randomBytes(len);
    const key = crypto.randomBytes(crypto.randomInt(0, 150));
    assert.equal(hex(Sig.sha256(new Uint8Array(data))), crypto.createHash('sha256').update(data).digest('hex'), `sha256 len=${len}`);
    assert.equal(hex(Sig.hmac(new Uint8Array(key), new Uint8Array(data))), crypto.createHmac('sha256', key).update(data).digest('hex'), `hmac len=${len}`);
    if (hasChacha) {
      const k = crypto.randomBytes(32); const n = crypto.randomBytes(12); const ctr = crypto.randomInt(0, 1000);
      const iv = Buffer.alloc(16); iv.writeUInt32LE(ctr, 0); n.copy(iv, 4);
      assert.equal(hex(Sig.chacha20(k, n, data, ctr)), crypto.createCipheriv('chacha20', k, iv).update(data).toString('hex'), `chacha20 len=${len}`);
    }
  }
  for (let i = 0; i < 20; i++) {
    const a = Sig.x25519Keys();
    const kp = crypto.generateKeyPairSync('x25519');
    const pub = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const theirs = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(a.pub)]), format: 'der', type: 'spki' }) });
    assert.equal(hex(Sig.x25519(a.priv, pub)), theirs.toString('hex'));
  }
});

test('шифрование: любое изменение любого байта обнаруживается; чужой ключ или направление — отказ', () => {
  for (let i = 0; i < 60; i++) {
    const data = crypto.randomBytes(crypto.randomInt(0, 3000));
    const box = Sig.encrypt('ключ', 'res', 'n' + i, data);
    assert.equal(Buffer.from(Sig.decrypt('ключ', 'res', 'n' + i, box)).toString('hex'), data.toString('hex'));
    const bad = Uint8Array.from(box);
    bad[crypto.randomInt(0, bad.length)] ^= 1 << crypto.randomInt(0, 8);
    assert.throws(() => Sig.decrypt('ключ', 'res', 'n' + i, bad));
    assert.throws(() => Sig.decrypt('другой', 'res', 'n' + i, box));
    assert.throws(() => Sig.decrypt('ключ', 'req', 'n' + i, box), 'ответ нельзя выдать за запрос');
    assert.throws(() => Sig.decrypt('ключ', 'res', 'другое', box), 'нельзя подставить ответ на другой запрос');
  }
  assert.throws(() => Sig.decrypt('ключ', 'res', 'n', new Uint8Array(10)), 'слишком короткие данные');
});
