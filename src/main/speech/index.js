'use strict';
// Распознавание голосовых сообщений: раскодирование в скрытом окне + Whisper в отдельном процессе.
const path = require('path');
const fs = require('fs');

const electron = () => require('electron');

class SpeechRecognizer {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = null;
    this.winReady = null;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.bound = false;
    this.idleTimer = null;
  }

  get modelDir() { return path.join(this.ctx.dataDir || process.cwd(), 'models'); }

  /** Скачана ли уже модель (первое распознавание скачивает ~250 МБ). */
  get modelReady() {
    try { return fs.readdirSync(path.join(this.modelDir, 'onnx-community', 'whisper-small', 'onnx')).length >= 2; } catch (e) { return false; }
  }

  bind() {
    if (this.bound) return;
    this.bound = true;
    const { ipcMain } = electron();
    ipcMain.on('decode:ready', (e) => { if (this.win && e.sender === this.win.webContents && this.readyResolve) this.readyResolve(); });
    ipcMain.on('decode:done', (e, m) => {
      if (!this.win || e.sender !== this.win.webContents) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m);
    });
  }

  ensureWindow() {
    if (this.win && !this.win.isDestroyed()) return this.winReady;
    const { BrowserWindow } = electron();
    this.bind();
    this.win = new BrowserWindow({
      show: false, width: 200, height: 200, skipTaskbar: true, focusable: false,
      webPreferences: { preload: path.join(__dirname, 'decode-preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
    });
    this.winReady = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Модуль аудио не запустился')), 15000);
      this.readyResolve = () => { clearTimeout(t); resolve(); };
      this.win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'audio-decode.html')).catch(reject);
    });
    this.win.on('closed', () => { this.win = null; });
    return this.winReady;
  }

  async decode(buffer) {
    await this.ensureWindow();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('Аудио не раскодировалось')); }, 30000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.win.webContents.send('decode:job', { id, data: buffer });
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const { utilityProcess } = electron();
    const w = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'PC Full Control — распознавание речи', stdio: 'ignore' });
    w.on('message', (m) => {
      const p = this.pending.get('w' + m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); return; }
      this.pending.delete('w' + m.id);
      if (m.type === 'error') p.reject(new Error(m.error)); else p.resolve(m);
    });
    w.on('exit', () => {
      if (this.worker === w) this.worker = null;
      for (const [k, p] of this.pending) if (String(k).startsWith('w')) { p.reject(new Error('Процесс распознавания завершился')); this.pending.delete(k); }
    });
    this.worker = w;
    return w;
  }

  /**
   * Голосовое сообщение (OGG/Opus и др.) → текст.
   * @param {Buffer} buffer
   * @param {{ onProgress?: (p: {pct:number,total:number}) => void }} opts
   */
  async transcribe(buffer, { onProgress = null } = {}) {
    const { pcm, duration } = await this.decode(buffer);
    if (duration > 120) throw new Error('Голосовое длиннее 2 минут — запишите команду покороче');
    const w = this.ensureWorker();
    const id = ++this.seq;
    clearTimeout(this.idleTimer);
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete('w' + id); reject(new Error('Распознавание заняло слишком много времени')); }, 15 * 60 * 1000);
      this.pending.set('w' + id, { onProgress, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      w.postMessage({ type: 'transcribe', id, pcm, cacheDir: this.modelDir, language: 'russian' });
    });
    // Через 10 минут без голосовых освобождаем память (модель ~500 МБ в памяти)
    this.idleTimer = setTimeout(() => this.stop(), 10 * 60 * 1000);
    return { text: res.text, ms: res.ms, duration };
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.worker) { try { this.worker.kill(); } catch (e) { /* ignore */ } this.worker = null; }
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { SpeechRecognizer };
