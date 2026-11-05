'use strict';
// Оптимизация: поиск и очистка временных файлов, корзины, кэшей.
// Правило: НИЧЕГО не удаляется без явного выбора пользователя — clean() принимает только
// список категорий, которые человек сам отметил и подтвердил. Анализ ничего не удаляет.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WIN, run, powershell } = require('./exec');

const HOUR = 3600 * 1000;
const env = (k, d = '') => process.env[k] || d;

/** Папки браузеров с кэшем (только кэш — не история, не пароли и не cookies). */
function browserCacheRoots() {
  const local = env('LOCALAPPDATA');
  const roots = [];
  const chromium = [
    ['Google', 'Chrome'], ['Microsoft', 'Edge'], ['Yandex', 'YandexBrowser'], ['BraveSoftware', 'Brave-Browser'], ['Vivaldi'],
  ];
  for (const parts of chromium) {
    const ud = path.join(local, ...parts, 'User Data');
    for (const prof of safeList(ud)) {
      if (!/^(Default|Profile \d+|Guest Profile)$/i.test(prof)) continue;
      for (const c of ['Cache', 'Code Cache', 'GPUCache', 'Service Worker\\CacheStorage']) roots.push(path.join(ud, prof, c));
    }
  }
  for (const operaDir of ['Opera Stable', 'Opera GX Stable']) roots.push(path.join(local, 'Opera Software', operaDir, 'Cache'));
  const ff = path.join(local, 'Mozilla', 'Firefox', 'Profiles');
  for (const prof of safeList(ff)) roots.push(path.join(ff, prof, 'cache2'));
  return roots;
}

function safeList(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

/** Наши собственные старые установщики и кэш обновлений (не трогает другие файлы в «Загрузках»). */
const OWN_INSTALLER_RE = /^(PCFullControl-Setup.*\.exe|PCControl-Android.*\.apk)$/i;
function ownInstallerRoots() {
  const home = os.homedir();
  return [path.join(home, 'Downloads'), path.join(home, 'Desktop'), path.join(env('LOCALAPPDATA'), 'pc-full-control-updater')];
}

/** Категории очистки для Windows. */
function windowsCategories() {
  const local = env('LOCALAPPDATA');
  const win = env('SystemRoot', 'C:\\Windows');
  const pd = env('ProgramData', 'C:\\ProgramData');
  return [
    {
      id: 'user-temp', icon: 'file', name: 'Временные файлы программ',
      desc: 'Папка TEMP вашей учётной записи. Файлы моложе часа и занятые программами не трогаются.',
      roots: () => [os.tmpdir()], minAgeMs: HOUR,
    },
    {
      id: 'win-temp', icon: 'windows', name: 'Временные файлы Windows',
      desc: 'Папка Windows\\Temp. Файлы моложе часа и занятые не трогаются.',
      roots: () => [path.join(win, 'Temp')], minAgeMs: HOUR,
    },
    {
      id: 'recycle', icon: 'trash', name: 'Корзина',
      desc: 'Файлы, которые вы уже удалили в корзину. После очистки восстановить их будет нельзя.',
      special: 'recycle',
    },
    {
      id: 'wu-cache', icon: 'download', name: 'Загруженные обновления Windows',
      desc: 'Уже установленные пакеты Windows Update (SoftwareDistribution\\Download). Файлы моложе суток не трогаются.',
      roots: () => [path.join(win, 'SoftwareDistribution', 'Download')], minAgeMs: 24 * HOUR,
    },
    {
      id: 'browsers', icon: 'globe', name: 'Кэш браузеров',
      desc: 'Chrome, Edge, Яндекс, Opera, Firefox, Brave: только кэш страниц. История, пароли и входы на сайты остаются. Для полной очистки закройте браузеры.',
      roots: browserCacheRoots,
    },
    {
      id: 'thumbs', icon: 'image', name: 'Кэш эскизов',
      desc: 'Миниатюры картинок и видео в Проводнике. Windows создаст их заново.',
      roots: () => [path.join(local, 'Microsoft', 'Windows', 'Explorer')], match: (n) => /^(thumbcache|iconcache)_.*\.db$/i.test(n),
    },
    {
      id: 'crash', icon: 'alert', name: 'Отчёты об ошибках и дампы',
      desc: 'Отчёты Windows об ошибках программ и аварийные дампы памяти.',
      roots: () => [path.join(local, 'CrashDumps'), path.join(local, 'Microsoft', 'Windows', 'WER'), path.join(pd, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), path.join(pd, 'Microsoft', 'Windows', 'WER', 'ReportQueue')],
    },
    {
      id: 'own-installers', icon: 'package', name: 'Старые установщики PC Full Control',
      desc: 'Скачанные ранее PCFullControl-Setup.exe и PCControl-Android.apk в «Загрузках» и на рабочем столе, кэш обновлений программы.',
      roots: ownInstallerRoots, match: (n, root) => /pc-full-control-updater$/i.test(root) || OWN_INSTALLER_RE.test(n),
    },
    {
      id: 'dns', icon: 'wifi', name: 'Кэш DNS',
      desc: 'Сброс сохранённых адресов сайтов. Помогает, если какой-то сайт перестал открываться.',
      special: 'dns',
    },
  ];
}

function linuxCategories() {
  const home = os.homedir();
  return [
    { id: 'user-cache-thumbs', icon: 'image', name: 'Кэш эскизов', desc: '~/.cache/thumbnails', roots: () => [path.join(home, '.cache', 'thumbnails')] },
    { id: 'trash', icon: 'trash', name: 'Корзина', desc: '~/.local/share/Trash', roots: () => [path.join(home, '.local', 'share', 'Trash', 'files'), path.join(home, '.local', 'share', 'Trash', 'info')] },
  ];
}

/** Корень, который нельзя чистить целиком: диск, системная папка, домашняя папка. */
function isUnsafeRoot(p) {
  if (!p || !path.isAbsolute(p)) return true;
  const norm = path.resolve(p).replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return true;
  const low = norm.toLowerCase();
  const forbidden = [os.homedir(), env('SystemRoot'), env('ProgramFiles'), env('ProgramFiles(x86)'), env('ProgramData'), env('APPDATA'), env('LOCALAPPDATA'), env('USERPROFILE')]
    .filter(Boolean).map((x) => path.resolve(x).replace(/[\\/]+$/, '').toLowerCase());
  return forbidden.includes(low);
}

/**
 * Обходит папку (без перехода по ссылкам) и считает размер файлов старше minAgeMs.
 * Возвращает { size, count }.
 */
function measure(root, { minAgeMs = 0, match = null, deadline = Infinity } = {}) {
  let size = 0;
  let count = 0;
  const now = Date.now();
  const stack = [];
  for (const name of safeList(root)) {
    if (match && !match(name, root)) continue;
    stack.push(path.join(root, name));
  }
  while (stack.length && Date.now() < deadline) {
    const p = stack.pop();
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      for (const n of safeList(p)) stack.push(path.join(p, n));
    } else if (!(minAgeMs > 0 && now - st.mtimeMs < minAgeMs)) {
      size += st.size;
      count++;
    }
  }
  return { size, count };
}

/** Удаляет содержимое root (подходящие под match), файлы младше minAgeMs и занятые — пропускает. */
function wipe(root, { minAgeMs = 0, match = null } = {}) {
  const res = { freed: 0, deleted: 0, skipped: 0 };
  if (isUnsafeRoot(root)) return res;
  const now = Date.now();
  const removeTree = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isSymbolicLink()) {
      // Ссылку удаляем саму по себе, не заходя внутрь
      try { fs.unlinkSync(p); res.deleted++; } catch (e) { try { fs.rmdirSync(p); res.deleted++; } catch (e2) { res.skipped++; } }
      return;
    }
    if (st.isDirectory()) {
      for (const n of safeList(p)) removeTree(path.join(p, n));
      try { fs.rmdirSync(p); } catch (e) { /* не пустая — там остались занятые или свежие файлы */ }
      return;
    }
    if (minAgeMs > 0 && now - st.mtimeMs < minAgeMs) { res.skipped++; return; }
    try {
      fs.unlinkSync(p);
      res.freed += st.size;
      res.deleted++;
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        try { fs.chmodSync(p, 0o666); fs.unlinkSync(p); res.freed += st.size; res.deleted++; return; } catch (e2) { /* занят */ }
      }
      res.skipped++;
    }
  };
  for (const name of safeList(root)) {
    if (match && !match(name, root)) continue;
    removeTree(path.join(root, name));
  }
  return res;
}

// ---------------- корзина (Windows) ----------------
async function userSid() {
  const r = await powershell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value', 20000);
  return r.code === 0 ? r.out.trim() : '';
}
function driveRoots() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(d)) out.push(d); } catch (e) { /* нет диска */ }
  }
  return out;
}
async function recycleRoots() {
  const sid = await userSid();
  if (!sid) return [];
  return driveRoots().map((d) => path.join(d, '$Recycle.Bin', sid)).filter((p) => fs.existsSync(p));
}

class Cleaner {
  constructor(categories = null) {
    this.categories = categories || (IS_WIN ? windowsCategories() : linuxCategories());
    this.busy = false;
  }

  list() {
    return this.categories.map((c) => ({ id: c.id, name: c.name, desc: c.desc, icon: c.icon }));
  }

  async rootsOf(c) {
    if (c.special === 'recycle') return recycleRoots();
    return (c.roots ? c.roots() : []).filter((r) => r && fs.existsSync(r));
  }

  /** Подсчёт, сколько места можно освободить. Ничего не удаляет. */
  async analyze() {
    const out = [];
    for (const c of this.categories) {
      const item = { id: c.id, name: c.name, desc: c.desc, icon: c.icon, size: 0, count: 0, measurable: c.special !== 'dns' };
      try {
        if (c.special === 'dns') { out.push(item); continue; }
        const deadline = Date.now() + 15000;
        for (const r of await this.rootsOf(c)) {
          const m = measure(r, { minAgeMs: c.minAgeMs || 0, match: c.match ? (n) => c.match(n, r) : null, deadline });
          item.size += m.size;
          item.count += m.count;
        }
        // В корзине служебные файлы $I* не считаем отдельными элементами
        if (c.special === 'recycle') item.count = Math.round(item.count / 2);
      } catch (e) { item.error = e.message; }
      out.push(item);
    }
    return out;
  }

  /**
   * Очищает ТОЛЬКО перечисленные категории. Пустой список или неизвестная категория — ошибка.
   * @param {string[]} ids
   */
  async clean(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Не выбрано, что очищать');
    const byId = new Map(this.categories.map((c) => [c.id, c]));
    for (const id of ids) if (!byId.has(id)) throw new Error(`Неизвестная категория: ${id}`);
    if (this.busy) throw new Error('Очистка уже идёт');
    this.busy = true;
    const results = [];
    try {
      for (const id of [...new Set(ids)]) {
        const c = byId.get(id);
        const r = { id, name: c.name, freed: 0, deleted: 0, skipped: 0 };
        try {
          if (c.special === 'dns') {
            const x = await run('ipconfig', ['/flushdns'], { timeout: 20000 });
            r.done = x.code === 0;
            if (!r.done) r.error = x.out;
          } else if (c.special === 'recycle') {
            const roots = await this.rootsOf(c);
            const before = roots.reduce((s, x) => s + measure(x).size, 0);
            await powershell('Clear-RecycleBin -Force -ErrorAction SilentlyContinue', 120000);
            const after = (await this.rootsOf(c)).reduce((s, x) => s + measure(x).size, 0);
            r.freed = Math.max(0, before - after);
            r.done = true;
          } else {
            for (const root of await this.rootsOf(c)) {
              const w = wipe(root, { minAgeMs: c.minAgeMs || 0, match: c.match ? (n) => c.match(n, root) : null });
              r.freed += w.freed; r.deleted += w.deleted; r.skipped += w.skipped;
            }
            r.done = true;
          }
        } catch (e) { r.error = e.message; }
        results.push(r);
      }
    } finally {
      this.busy = false;
    }
    return results;
  }
}

module.exports = { Cleaner, measure, wipe, isUnsafeRoot, OWN_INSTALLER_RE };
