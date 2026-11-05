'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tune, sortCodecs } = require('../src/shared/sdp');
const { PRESETS, ScreenStream } = require('../src/main/stream');

const SDP = [
  'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103',
  'a=rtpmap:96 VP8/90000', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000', 'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  'a=rtpmap:103 rtx/90000', 'a=fmtp:103 apt=102',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', '',
].join('\r\n');

test('SDP: подсказки битрейта для видео и стерео для звука', () => {
  const out = tune(SDP, { start: 15000, min: 1500, max: 25000 });
  assert.match(out, /a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=15000;x-google-min-bitrate=1500;x-google-max-bitrate=25000\r\n/);
  assert.match(out, /a=rtpmap:96 VP8\/90000\r\na=fmtp:96 x-google-start-bitrate=15000/);
  assert.match(out, /a=fmtp:97 apt=96\r\n/); // служебные кодеки не трогаем
  assert.doesNotMatch(out, /fmtp:97 apt=96;x-google/);
  assert.match(out, /a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000/);
  assert.ok(out.endsWith('\r\n'));
  // повторная обработка не дублирует параметры
  const twice = tune(out, { start: 15000, min: 1500, max: 25000 });
  assert.equal((twice.match(/x-google-start-bitrate/g) || []).length, 2);
});

test('кодеки: H.264 первым, служебные в конце', () => {
  const list = [
    { mimeType: 'video/VP8' }, { mimeType: 'video/rtx' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/VP9' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/AV1' }, { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=640c1f' },
  ];
  const order = sortCodecs(list).map((c) => `${c.mimeType} ${c.sdpFmtpLine || ''}`.trim());
  assert.deepEqual(order, [
    'video/H264 packetization-mode=1;profile-level-id=640c1f',
    'video/H264 packetization-mode=1;profile-level-id=42e01f',
    'video/H264 packetization-mode=0;profile-level-id=42e01f',
    'video/VP9', 'video/AV1', 'video/VP8', 'video/rtx',
  ]);
});

test('режимы качества: есть 120 кадр/с и разумные битрейты', () => {
  assert.equal(PRESETS.smooth.fps, 120);
  for (const p of Object.values(PRESETS)) {
    assert.ok(p.bitrate >= 1000 && p.bitrate <= 60000);
    assert.ok(['balanced', 'maintain-resolution', 'maintain-framerate'].includes(p.degradation));
  }
  assert.deepEqual(ScreenStream.presets().map((p) => p.id), ['auto', 'quality', 'smooth', 'eco']);
});
