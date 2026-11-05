'use strict';
// Скрытое окно: раскодирует голосовое сообщение (OGG/Opus, MP3, M4A…) в 16 кГц моно для распознавания речи.
window.decoder.onJob(async ({ id, data }) => {
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(new Uint8Array(data).buffer);
    ctx.close();
    const len = Math.max(1, Math.ceil(buf.duration * 16000));
    const off = new OfflineAudioContext(1, len, 16000);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    const pcm = out.getChannelData(0);
    window.decoder.done(id, { pcm: pcm.buffer.slice(0), duration: buf.duration });
  } catch (e) {
    window.decoder.done(id, { error: 'Не удалось прочитать аудио: ' + (e.message || e.name) });
  }
});
window.decoder.ready();
