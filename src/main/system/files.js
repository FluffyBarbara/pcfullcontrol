'use strict';
// Файловый менеджер: просмотр папок, скачивание и загрузка файлов.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WIN } = require('./exec');

const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;

class FileAccessError extends Error {}

function safeFilename(name) {
  let n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  if (IS_WIN && /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n.slice(0, 200);
}

class FileManager {
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  get allowedRoots() {
    return (this.getConfig().files.allowedRoots || []).filter(Boolean).map((r) => path.resolve(r));
  }

  get uploadDir() {
    return this.getConfig().files.uploadDir || path.join(os.homedir(), 'Downloads', 'PCControl');
  }

  check(p) {
    const resolved = path.resolve(String(p || ''));
    const roots = this.allowedRoots;
    const norm = (x) => (IS_WIN ? x.toLowerCase() : x);
    if (roots.length && !roots.some((r) => norm(resolved) === norm(r) || norm(resolved).startsWith(norm(r.endsWith(path.sep) ? r : r + path.sep)))) {
      throw new FileAccessError('Доступ к этой папке запрещён настройками');
    }
    return resolved;
  }

  roots() {
    let paths;
    if (this.allowedRoots.length) {
      paths = this.allowedRoots;
    } else {
      const home = os.homedir();
      paths = [home, ...['Desktop', 'Downloads', 'Documents'].map((d) => path.join(home, d)).filter((d) => fs.existsSync(d))];
      if (IS_WIN) {
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const drive = `${letter}:\\`;
          try { fs.accessSync(drive); paths.push(drive); } catch (e) { /* нет диска */ }
        }
      } else {
        paths.push('/');
      }
    }
    return paths.map((p) => ({ name: p, path: p, isDir: true, size: null }));
  }

  listDir(p) {
    const dir = this.check(p);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new FileAccessError(e.code === 'EACCES' || e.code === 'EPERM' ? 'Нет прав на чтение этой папки' : `Не удалось открыть папку: ${e.code || e.message}`);
    }
    const items = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        const isDir = e.isDirectory();
        const st = isDir ? null : fs.statSync(full);
        items.push({ name: e.name, path: full, isDir, size: st ? st.size : null, mtime: st ? st.mtimeMs / 1000 : null });
      } catch (err) { /* недоступный файл */ }
    }
    items.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'ru')));
    return items;
  }

  parent(p) {
    const cur = this.check(p);
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    const roots = this.allowedRoots;
    if (roots.length && roots.some((r) => r.toLowerCase() === cur.toLowerCase())) return null;
    return parent;
  }

  fileForDownload(p) {
    const f = this.check(p);
    let st;
    try { st = fs.statSync(f); } catch (e) { throw new FileAccessError('Файл не найден'); }
    if (!st.isFile()) throw new FileAccessError('Это не файл');
    return { path: f, size: st.size, name: path.basename(f) };
  }

  /** Пути, которые нельзя удалить ни при каких условиях: корни дисков, системные папки, сама домашняя папка. */
  static isProtected(p) {
    const r = path.resolve(p);
    const low = (IS_WIN ? r.toLowerCase() : r).replace(/[\\/]+$/, '');
    if (path.parse(r).root.replace(/[\\/]+$/, '').toLowerCase() === low || r === path.parse(r).root) return true;
    const env = (k) => process.env[k];
    const crit = [os.homedir(), env('SystemRoot'), env('ProgramFiles'), env('ProgramFiles(x86)'), env('ProgramData'), env('APPDATA'), env('LOCALAPPDATA'),
      ...['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos'].map((d) => path.join(os.homedir(), d)),
      ...(IS_WIN ? [] : ['/bin', '/boot', '/etc', '/usr', '/var', '/lib', '/sbin', '/root', '/home'])]
      .filter(Boolean).map((x) => (IS_WIN ? path.resolve(x).toLowerCase() : path.resolve(x)));
    if (crit.includes(low)) return true;
    const sys = (env('SystemRoot') || 'C:\\Windows').toLowerCase();
    return IS_WIN && (low === sys || low.startsWith(sys + '\\'));
  }

  /**
   * Удаляет ТОЛЬКО перечисленные пользователем файлы и папки.
   * По умолчанию — в корзину (можно восстановить); permanent — безвозвратно.
   * @param {string[]} paths
   * @param {{ permanent?: boolean, trash?: (p:string)=>Promise<void> }} opts
   */
  async deletePaths(paths, { permanent = false, trash = null } = {}) {
    if (!Array.isArray(paths) || !paths.length) throw new FileAccessError('Ничего не выбрано');
    if (paths.length > 500) throw new FileAccessError('Слишком много файлов за один раз (максимум 500)');
    const results = [];
    for (const raw of paths) {
      const r = { path: String(raw), ok: false };
      try {
        const p = this.check(raw);
        if (FileManager.isProtected(p)) throw new FileAccessError('Эту папку удалять нельзя — она нужна системе');
        let st;
        try { st = fs.lstatSync(p); } catch (e) { throw new FileAccessError('Файл не найден'); }
        r.isDir = st.isDirectory();
        if (!permanent && trash) await trash(p);
        else fs.rmSync(p, { recursive: true, force: false, maxRetries: 2 });
        r.ok = !fs.existsSync(p);
        if (!r.ok) r.error = 'Файл занят другой программой';
      } catch (e) {
        r.error = e instanceof FileAccessError ? e.message : (e.code === 'EBUSY' || e.code === 'EPERM' ? 'Файл занят или нет прав' : e.message);
      }
      results.push(r);
    }
    return results;
  }

  saveUpload(filename, data, directory = null) {
    const dir = directory ? this.check(directory) : this.uploadDir;
    fs.mkdirSync(dir, { recursive: true });
    const name = safeFilename(filename) || `file_${Date.now()}`;
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      target = path.join(dir, `${path.basename(name, ext)}_${Date.now()}${ext}`);
    }
    fs.writeFileSync(target, data);
    return target;
  }
}

module.exports = { FileManager, FileAccessError, safeFilename, TELEGRAM_UPLOAD_LIMIT };
