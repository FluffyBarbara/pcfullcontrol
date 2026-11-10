'use strict';
// Скриншоты (средствами Electron) и фото с веб-камеры (через скрытое окно).
const path = require('path');

function electron() {
  return require('electron');
}

/** Список экранов: [{ index, sourceId, width, height }] */
async function displays() {
  const { screen } = electron();
  return screen.getAllDisplays().map((d, i) => ({
    index: i + 1,
    id: String(d.id),
    width: Math.round(d.size.width * d.scaleFactor),
    height: Math.round(d.size.height * d.scaleFactor),
  }));
}

/** Скриншот в JPEG. monitor: 0 — все экраны (массив), N — конкретный. */
async function screenshots(monitor = 0, quality = 80) {
  const { desktopCapturer } = electron();
  const ds = await displays();
  const maxW = Math.max(...ds.map((d) => d.width), 1920);
  const maxH = Math.max(...ds.map((d) => d.height), 1080);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
  if (!sources.length) throw new Error('Не удалось получить изображение экрана');
  let chosen = sources;
  if (monitor > 0) {
    const d = ds[monitor - 1];
    const byId = d && sources.find((s) => s.display_id === d.id);
    chosen = [byId || sources[monitor - 1] || sources[0]];
  }
  return chosen.map((s) => s.thumbnail.toJPEG(quality));
}

async function screenshot(monitor = 1, quality = 80) {
  return (await screenshots(monitor || 1, quality))[0];
}

/** Фото с веб-камеры: скрытое окно делает getUserMedia и возвращает кадр. */
async function webcamPhoto() {
  const { BrowserWindow, ipcMain } = electron();
  const win = new BrowserWindow({
    show: false, width: 640, height: 480,
    webPreferences: { preload: path.join(__dirname, '..', 'capture-preload.js'), contextIsolation: true, sandbox: true },
  });
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Камера не ответила (занята или отсутствует)')), 20000);
      const handler = (event, payload) => {
        if (event.sender !== win.webContents) return;
        clearTimeout(timer);
        ipcMain.removeListener('webcam-result', handler);
        if (payload && payload.error) reject(new Error(payload.error));
        else resolve(payload.data);
      };
      ipcMain.on('webcam-result', handler);
      win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'capture.html')).catch(reject);
    });
    return Buffer.from(result.split(',')[1], 'base64');
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { screenshot, screenshots, displays, webcamPhoto };
