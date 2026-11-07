'use strict';
// Файловый менеджер: просмотр папок, скачивание и загрузка файлов.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WIN } = require('./exec');

const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;

class FileAccessError extends Error {}

// Файлы, которые запускаются или исполняют код при открытии: их нельзя прислать на ПК с телефона —
// иначе укравший доступ к телефону положил бы программу и открыл её («Запустить программу»).
const EXEC_EXT = /\.(exe|com|scr|pif|bat|cmd|ps1|psm1|psd1|ps1xml|vbs|vbe|js|jse|wsf|wsh|hta|msc|msi|msp|mst|dll|ocx|cpl|sys|drv|lnk|url|scf|reg|inf|jar|application|appref-ms|settingcontent-ms|library-ms|search-ms|chm|xll|gadget|iso|img|vhd|vhdx|appx|appxbundle|msix|msixbundle|docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|ppsm|sldm|sh|desktop)$/i;

function safeFilename(name) {
  let n = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[ .]+|[ .]+$/g, '');
  if (IS_WIN && /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = '_' + n;
  return n.slice(0, 200);
}

const norm = (x) => (IS_WIN ? x.toLowerCase() : x).replace(/[\\/]+$/, '') || x;
const inside = (p, dir) => { const a = norm(p); const b = norm(dir); return a === b || a.startsWith(b + (IS_WIN ? '\\' : '/')); };

/** Настоящий путь (раскрывает ярлыки-«соединения» и символические ссылки, которыми можно выйти за разрешённую папку). */
function realPath(p) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...tail.reverse()); } catch (e) { /* ещё не существует */ }
    const up = path.dirname(cur);
    if (up === cur) return p;
    tail.push(path.basename(cur));
    cur = up;
  }
  return p;
}

class FileManager {
  /**
   * @param {() => object} getConfig
   * @param {{ dataDir?: () => string|null, onAlarm?: (p: string, op: string) => void }} [o]
   */
  constructor(getConfig, { dataDir = () => null, onAlarm = () => {} } = {}) {
    this.getConfig = getConfig;
    this.dataDir = dataDir;
    this.onAlarm = onAlarm;
  }

  get cfg() { return this.getConfig().files || {}; }

  get allowedRoots() {
    return (this.cfg.allowedRoots || []).filter(Boolean).map((r) => path.resolve(r));
  }

  /** «Весь диск» — только если пользователь включил это сам в настройках. */
  get fullDisk() { return !!this.cfg.fullDiskAccess; }

  /** Папки, куда нельзя ни смотреть, ни писать: данные этой программы и секреты системы и браузеров. */
  sensitive() {
    const home = os.homedir();
    const env = (k) => process.env[k];
    const list = [this.dataDir(), path.join(home, '.ssh'), path.join(home, '.gnupg'), path.join(home, '.aws'), path.join(home, '.azure'), path.join(home, '.kube'), path.join(home, '.docker')];
    if (!this.fullDisk) list.push(env('APPDATA'), env('LOCALAPPDATA'), path.join(home, 'AppData'), path.join(home, '.config'), path.join(home, '.local'));
    return list.filter(Boolean).map((x) => path.resolve(x));
  }

  /** Куда нельзя писать даже в режиме «весь диск»: автозагрузка, система, программы, данные программ. */
  writeForbidden() {
    const env = (k) => process.env[k];
    return [this.dataDir(), env('APPDATA'), env('LOCALAPPDATA'), path.join(os.homedir(), 'AppData'), env('SystemRoot'), env('windir'), env('ProgramFiles'), env('ProgramFiles(x86)'), env('ProgramW6432'), env('ProgramData'),
      ...(IS_WIN ? [] : ['/bin', '/boot', '/etc', '/usr', '/lib', '/sbin', '/var', path.join(os.homedir(), '.config'), path.join(os.homedir(), '.local')])]
      .filter(Boolean).map((x) => path.resolve(x));
  }

  get uploadDir() {
    return this.getConfig().files.uploadDir || path.join(os.homedir(), 'Downloads', 'PCControl');
  }

  /**
   * Проверка доступа. По умолчанию — только домашняя папка пользователя (без AppData и ключей);
   * «весь диск» — отдельной настройкой. Данные этой программы недоступны никогда.
   */
  check(p, op = 'read') {
    const raw = String(p || '');
    if (!raw || raw.includes('\0')) throw new FileAccessError('Неверный путь');
    if (IS_WIN && /^\\\\|^\/\//.test(raw)) throw new FileAccessError('Сетевые пути недоступны');
    const resolved = path.resolve(raw);
    const real = realPath(resolved);
    for (const x of [resolved, real]) {
      const dd = this.dataDir();
      if (dd && inside(x, path.resolve(dd))) { this.onAlarm(x, op); throw new FileAccessError('Данные программы недоступны с телефона'); }
      if (this.sensitive().some((s) => inside(x, s))) throw new FileAccessError('Эта папка закрыта: в ней пароли и данные программ');
    }
    const roots = this.allowedRoots;
    // Папка загрузок доступна всегда — туда сохраняются файлы с телефона
    const area = roots.length ? [...roots, path.resolve(this.uploadDir)] : this.fullDisk ? null : [os.homedir(), path.resolve(this.uploadDir)];
    if (area && !area.some((r) => inside(resolved, r) && inside(real, realPath(r)))) {
      throw new FileAccessError(roots.length ? 'Доступ к этой папке запрещён настройками' : 'Доступна только ваша папка пользователя. Весь диск можно открыть в настройках программы на ПК.');
    }
    return resolved;
  }

  /** Куда можно сохранять файлы с телефона: только папка загрузок, если пользователь не разрешил иное. */
  checkWrite(dir) {
    const d = this.check(dir, 'write');
    const real = realPath(d);
    const up = path.resolve(this.uploadDir);
    if (!this.cfg.uploadAnywhere && !(inside(d, up) && inside(real, realPath(up)))) {
      throw new FileAccessError(`Сохранять файлы можно только в папку загрузок (${up}). Другие папки разрешаются в настройках программы на ПК.`);
    }
    if (this.writeForbidden().some((w) => inside(d, w) || inside(real, w))) throw new FileAccessError('В эту папку сохранять нельзя — она нужна системе или программам');
    return d;
  }

  roots() {
    let paths;
    if (this.allowedRoots.length) {
      paths = this.allowedRoots;
    } else {
      const home = os.homedir();
      paths = [home, ...['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos'].map((d) => path.join(home, d)).filter((d) => fs.existsSync(d))];
      if (!this.fullDisk) { /* только домашняя папка */ } else if (IS_WIN) {
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
    const roots = this.allowedRoots.length ? this.allowedRoots : this.fullDisk ? [] : [os.homedir()];
    if (roots.some((r) => norm(r) === norm(cur))) return null;
    try { this.check(parent); } catch (e) { return null; }
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
    if (IS_WIN && /^(pagefile|hiberfil|swapfile)\.sys$|^dumpstack\.log/i.test(path.basename(r))) return true;
    const sys = (env('SystemRoot') || 'C:\\Windows').toLowerCase();
    return IS_WIN && (low === sys || low.startsWith(sys + '\\'));
  }

  /**
   * Удаляет ТОЛЬКО перечисленные пользователем файлы и папки.
   * По умолчанию — в корзину (можно восстановить); permanent — безвозвратно.
   * @param {string[]} paths
   * @param {{ permanent?: boolean, trash?: (p:string)=>Promise<void> }} opts
   */
  async deletePaths(paths, { permanent = false, trash = null, local = false } = {}) {
    if (!Array.isArray(paths) || !paths.length) throw new FileAccessError('Ничего не выбрано');
    if (paths.length > 500) throw new FileAccessError('Слишком много файлов за один раз (максимум 500)');
    const results = [];
    for (const raw of paths) {
      const r = { path: String(raw), ok: false };
      try {
        // С телефона — только в доступных папках и не в системных; с самого ПК — где угодно, кроме системного
        const p = local ? path.resolve(String(raw)) : this.check(raw, 'delete');
        if (!local && this.writeForbidden().some((w) => inside(p, w))) throw new FileAccessError('Удалять в этой папке с телефона нельзя — она нужна системе или программам');
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
    const name = safeFilename(filename) || `file_${Date.now()}`;
    if (EXEC_EXT.test(name)) throw new FileAccessError('Программы и скрипты (.exe, .bat, .ps1, .lnk и т. п.) принимать нельзя — так злоумышленник мог бы запустить свой код. Отправьте файл в архиве .zip.');
    const dir = this.checkWrite(directory || this.uploadDir);
    fs.mkdirSync(dir, { recursive: true });
    let target = path.join(dir, name);
    if (fs.existsSync(target)) {
      const ext = path.extname(name);
      target = path.join(dir, `${path.basename(name, ext)}_${Date.now()}${ext}`);
    }
    fs.writeFileSync(target, data);
    return target;
  }
}

module.exports = { FileManager, FileAccessError, safeFilename, TELEGRAM_UPLOAD_LIMIT, EXEC_EXT };
