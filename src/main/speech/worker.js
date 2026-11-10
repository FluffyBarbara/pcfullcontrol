'use strict';
// Отдельный процесс распознавания речи (Whisper через transformers.js + onnxruntime).
// Модель скачивается один раз в папку данных программы и дальше работает без интернета.
let pipePromise = null;

function getPipe(cacheDir, onProgress) {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = cacheDir;
      env.allowLocalModels = true;
      return pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', {
        // Закреплённая версия модели (коммит на HuggingFace): обновление или подмена модели в репозитории
        // не приведёт к тихой загрузке других файлов
        revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
        dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
        progress_callback: (p) => { if (p && p.status === 'progress' && p.total > 1e6) onProgress({ file: p.file, loaded: p.loaded, total: p.total }); },
      });
    })();
    pipePromise.catch(() => { pipePromise = null; });
  }
  return pipePromise;
}

process.parentPort.on('message', async (e) => {
  const m = e.data || {};
  if (m.type !== 'transcribe') return;
  const reply = (x) => process.parentPort.postMessage({ id: m.id, ...x });
  try {
    let lastPct = -1;
    const asr = await getPipe(m.cacheDir, (p) => {
      const pct = Math.floor((p.loaded / p.total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; reply({ type: 'progress', file: p.file, pct, total: p.total }); }
    });
    const raw = m.pcm;
    const ab = raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const audio = new Float32Array(ab);
    const t0 = Date.now();
    const out = await asr(audio, { language: m.language || 'russian', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    reply({ type: 'result', text: String(out.text || '').trim(), ms: Date.now() - t0 });
  } catch (err) {
    reply({ type: 'error', error: err && err.message ? err.message : String(err) });
  }
});
