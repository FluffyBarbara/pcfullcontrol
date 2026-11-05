'use strict';
// Удаление программ: список установленных (из реестра Windows), запуск их деинсталлятора
// и поиск остатков — папок и разделов реестра. Ничего не удаляется без выбора пользователя:
// деинсталлятор запускается только по команде, остатки удаляются только отмеченные.
// Перед удалением разделов реестра делается резервная копия (.reg), её можно вернуть двойным щелчком.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { IS_WIN, run, powershell } = require('./exec');

const env = (k, d = '') => process.env[k] || d;
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

// Имена, которые никогда не считаются «остатками программы»
const PROTECTED_NAMES = new Set([
  'microsoft', 'windows', 'common files', 'windowsapps', 'system32', 'syswow64', 'temp', 'programs', 'packages', 'users',
  'program files', 'program files (x86)', 'programdata', 'appdata', 'local', 'roaming', 'locallow', 'start menu', 'desktop',
  'documents', 'downloads', 'software', 'classes', 'policies', 'wow6432node', 'internet explorer', 'windows defender',
  'windows nt', 'microsoft.net', 'reference assemblies', 'msbuild', 'installer', 'package cache', 'drivers', 'driverstore',
]);

const LIST_PS = `
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$out = foreach ($p in $paths) {
  Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object {
    $_.DisplayName -and $_.SystemComponent -ne 1 -and -not $_.ParentKeyName -and ($_.ReleaseType -notmatch 'Update|Hotfix')
  } | ForEach-Object {
    [pscustomobject]@{
      key = ($_.PSPath -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::', '')
      name = [string]$_.DisplayName; version = [string]$_.DisplayVersion; publisher = [string]$_.Publisher
      location = [string]$_.InstallLocation; uninstall = [string]$_.UninstallString; quiet = [string]$_.QuietUninstallString
      size = [int64]($_.EstimatedSize); date = [string]$_.InstallDate; icon = [string]$_.DisplayIcon
      noRemove = [int]($_.NoRemove); windowsInstaller = [int]($_.WindowsInstaller)
    }
  }
}
ConvertTo-Json -InputObject @($out) -Depth 3 -Compress`;

/** «Telegram Desktop 5.1.2 (x64)» → «Telegram Desktop». */
function cleanName(name) {
  return String(name || '')
    .replace(/\s*\((x64|x86|64-bit|32-bit|64 bit|32 bit|amd64|arm64)\)\s*/gi, ' ')
    .replace(/\s+(x64|x86|64-bit|32-bit)$/i, '')
    .replace(/\s+v?\d+(\.\d+)+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Разбор строки удаления: '"C:\\a b\\unins000.exe" /SILENT' → { exe, args }. */
function parseCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return null;
  const msi = /msiexec(\.exe)?/i.test(s) && /\{[0-9A-F-]{36}\}/i.exec(s);
  if (msi) return { exe: 'msiexec.exe', args: `/x ${msi[0]}`, msi: msi[0] };
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end > 1) return { exe: s.slice(1, end), args: s.slice(end + 1).trim() };
  }
  // Путь без кавычек с пробелами: берём самый короткий префикс, оканчивающийся на .exe
  const m = /^(.+?\.exe)(\s+.*)?$/i.exec(s);
  if (m) return { exe: m[1], args: (m[2] || '').trim() };
  const sp = s.indexOf(' ');
  return sp < 0 ? { exe: s, args: '' } : { exe: s.slice(0, sp), args: s.slice(sp + 1).trim() };
}

function isProtectedName(n) {
  const low = String(n || '').trim().toLowerCase();
  return !low || low.length < 3 || PROTECTED_NAMES.has(low);
}

/** Папка подходит как «остаток», только если её последний сегмент — имя программы, а не системная папка. */
function safeLeftoverDir(p) {
  if (!p || !path.isAbsolute(p)) return false;
  const norm = path.resolve(p).replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return false;
  if (isProtectedName(parts[parts.length - 1])) return false;
  const forbidden = [os.homedir(), env('SystemRoot'), env('ProgramFiles'), env('ProgramFiles(x86)'), env('ProgramData'), env('APPDATA'), env('LOCALAPPDATA'), env('USERPROFILE')]
    .filter(Boolean).map((x) => path.resolve(x).toLowerCase());
  const low = norm.toLowerCase();
  if (forbidden.includes(low)) return false;
  const sys = env('SystemRoot', 'C:\\Windows').toLowerCase();
  if (low === sys || low.startsWith(sys + path.sep)) return false;
  return true;
}

function dirSize(p, deadline = Date.now() + 5000) {
  let size = 0;
  const stack = [p];
  while (stack.length && Date.now() < deadline) {
    const x = stack.pop();
    let st;
    try { st = fs.lstatSync(x); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { try { for (const n of fs.readdirSync(x)) stack.push(path.join(x, n)); } catch (e) { /* нет доступа */ } } else size += st.size;
  }
  return size;
}

async function regExists(key) {
  const r = await run('reg.exe', ['query', key], { timeout: 15000 });
  return r.code === 0;
}

class AppsManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.apps = new Map();      // id -> запись
    this.jobs = new Map();      // id -> ход удаления
    this.leftovers = new Map(); // id -> найденные остатки (только их можно удалить)
  }

  get available() { return IS_WIN; }

  async list() {
    if (!IS_WIN) return [];
    const r = await powershell(LIST_PS, 60000);
    let rows = [];
    try { rows = JSON.parse(r.out || '[]'); } catch (e) { throw new Error('Не удалось прочитать список программ'); }
    if (!Array.isArray(rows)) rows = [rows];
    const seen = new Set();
    const out = [];
    this.apps.clear();
    for (const a of rows) {
      if (!a || !a.name) continue;
      const dup = `${a.name}|${a.version}`.toLowerCase();
      if (seen.has(dup)) continue;
      seen.add(dup);
      const id = sha(a.key);
      const self = /^PC Full Control\b/i.test(a.name);
      const rec = { ...a, id, self };
      this.apps.set(id, rec);
      out.push({
        id, name: a.name, version: a.version, publisher: a.publisher, location: a.location,
        size: a.size ? a.size * 1024 : 0, date: a.date, hasUninstaller: !!(a.uninstall || a.quiet), canQuiet: !!a.quiet || !!a.windowsInstaller,
        self, job: this.jobs.get(id) || null,
      });
    }
    out.sort((x, y) => x.name.localeCompare(y.name, 'ru'));
    return out;
  }

  get(id) {
    const a = this.apps.get(String(id || ''));
    if (!a) throw new Error('Программа не найдена — обновите список');
    return a;
  }

  /** Запускает деинсталлятор программы (окно деинсталлятора появится на экране ПК). */
  async uninstall(id, { quiet = false } = {}) {
    const a = this.get(id);
    if (a.self) throw new Error('PC Full Control удаляется через «Параметры Windows → Приложения»');
    const cur = this.jobs.get(id);
    if (cur && cur.state === 'running') throw new Error('Удаление уже идёт');
    const cmdline = quiet && a.quiet ? a.quiet : a.uninstall;
    const cmd = parseCommand(cmdline);
    if (!cmd) throw new Error('У программы нет деинсталлятора — можно удалить только остатки');
    if (cmd.msi && quiet) cmd.args += ' /qn /norestart';
    if (!cmd.msi && !fs.existsSync(cmd.exe)) throw new Error(`Деинсталлятор не найден: ${cmd.exe}`);
    const job = { state: 'running', started: Date.now(), name: a.name, exitCode: null, removed: false };
    this.jobs.set(id, job);
    this.ctx.db.logCommand('local', 'ПК', 'uninstall', a.name, true, 'запущен деинсталлятор');
    // Путь к деинсталлятору в кавычках — иначе программа неверно прочитает свою командную строку, если в пути есть пробелы
    const child = spawn(cmd.exe, cmd.args ? [cmd.args] : [], { argv0: `"${cmd.exe}"`, windowsVerbatimArguments: true, windowsHide: false, detached: false, stdio: 'ignore' });
    child.on('error', (e) => { job.state = 'done'; job.error = e.message; });
    child.on('exit', async (code) => {
      job.exitCode = code;
      // Некоторые деинсталляторы (NSIS, Inno) копируют себя во временную папку и сразу завершаются —
      // ждём, пока запись программы исчезнет из реестра (до 10 минут)
      const until = Date.now() + 10 * 60 * 1000;
      while (Date.now() < until) {
        if (!(await regExists(a.key))) { job.removed = true; break; }
        if (code !== 0 && Date.now() - job.started > 20000) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      job.state = 'done';
      job.finished = Date.now();
      this.ctx.emit('event');
    });
    return { ok: true, message: `Запущен деинсталлятор «${a.name}». Следуйте его шагам на экране компьютера.` };
  }

  job(id) { return this.jobs.get(String(id || '')) || null; }

  /** Поиск остатков: папки и разделы реестра, связанные с программой. Ничего не удаляет. */
  async findLeftovers(id) {
    const a = this.get(id);
    if (a.self) throw new Error('Это сама программа PC Full Control');
    const names = new Set();
    for (const n of [a.name, cleanName(a.name)]) if (!isProtectedName(n)) names.add(n.trim());
    if (a.location) {
      const base = path.basename(a.location.replace(/[\\/"]+$/, '').replace(/^"/, ''));
      if (!isProtectedName(base)) names.add(base);
    }
    const pub = cleanName(a.publisher).replace(/[,.]?\s+(Inc|LLC|Ltd|GmbH|Corporation|Corp|Co|S\.A|AB|B\.V)\.?$/i, '').trim();
    const pubs = [a.publisher, pub].filter((p) => p && !isProtectedName(p));

    const dirRoots = [env('APPDATA'), env('LOCALAPPDATA'), path.join(env('LOCALAPPDATA'), 'Programs'), env('ProgramData'),
      env('ProgramFiles', 'C:\\Program Files'), env('ProgramFiles(x86)', 'C:\\Program Files (x86)'),
      path.join(os.homedir(), 'AppData', 'LocalLow'),
      path.join(env('APPDATA'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(env('ProgramData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')].filter(Boolean);
    const dirs = new Set();
    if (a.location) dirs.add(a.location.replace(/^"|"$/g, '').replace(/[\\/]+$/, ''));
    for (const root of dirRoots) {
      for (const n of names) {
        dirs.add(path.join(root, n));
        for (const p of pubs) dirs.add(path.join(root, p, n));
      }
    }
    // Ярлыки на рабочем столе и в меню «Пуск»
    const lnkRoots = [path.join(os.homedir(), 'Desktop'), path.join(env('PUBLIC', 'C:\\Users\\Public'), 'Desktop'),
      path.join(env('APPDATA'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(env('ProgramData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')];

    const items = [];
    const seen = new Set();
    for (const d of dirs) {
      const key = d.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!safeLeftoverDir(d)) continue;
      let st;
      try { st = fs.statSync(d); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      items.push({ kind: 'dir', path: d, size: dirSize(d) });
    }
    for (const root of lnkRoots) {
      for (const n of names) {
        const f = path.join(root, n + '.lnk');
        if (fs.existsSync(f) && !seen.has(f.toLowerCase())) { seen.add(f.toLowerCase()); items.push({ kind: 'file', path: f, size: fs.statSync(f).size }); }
      }
    }
    // Реестр: запись в списке программ и раздел настроек программы
    const regKeys = new Set([a.key]);
    for (const hive of ['HKCU\\Software', 'HKLM\\SOFTWARE', 'HKLM\\SOFTWARE\\WOW6432Node']) {
      for (const n of names) {
        regKeys.add(`${hive}\\${n}`);
        for (const p of pubs) regKeys.add(`${hive}\\${p}\\${n}`);
      }
    }
    for (const k of regKeys) {
      const last = k.split('\\').pop();
      if (k !== a.key && isProtectedName(last)) continue;
      if (await regExists(k)) items.push({ kind: 'reg', path: k, uninstallEntry: k === a.key });
    }
    const list = items.map((x, i) => ({ ...x, token: `${i}-${sha(x.path)}` }));
    this.leftovers.set(a.id, list);
    return list;
  }

  /** Удаляет ТОЛЬКО отмеченные пользователем остатки из последнего поиска. */
  async removeLeftovers(id, tokens) {
    const a = this.get(id);
    const found = this.leftovers.get(a.id) || [];
    if (!Array.isArray(tokens) || !tokens.length) throw new Error('Ничего не выбрано');
    const chosen = found.filter((x) => tokens.includes(x.token));
    if (!chosen.length) throw new Error('Выбранные элементы не найдены — повторите поиск');
    const backupDir = path.join(this.ctx.dataDir || os.tmpdir(), 'backups', 'registry');
    const results = [];
    for (const x of chosen) {
      const r = { path: x.path, kind: x.kind, ok: false };
      try {
        if (x.kind === 'reg') {
          fs.mkdirSync(backupDir, { recursive: true });
          const file = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${sha(x.path)}.reg`);
          const ex = await run('reg.exe', ['export', x.path, file, '/y'], { timeout: 30000 });
          if (ex.code !== 0) throw new Error('Не удалось сохранить резервную копию раздела — удаление отменено');
          const del = await run('reg.exe', ['delete', x.path, '/f'], { timeout: 30000 });
          if (del.code !== 0) throw new Error(del.out || 'Не удалось удалить раздел');
          r.backup = file;
        } else if (x.kind === 'dir') {
          if (!safeLeftoverDir(x.path)) throw new Error('Эту папку удалять нельзя');
          fs.rmSync(x.path, { recursive: true, force: true, maxRetries: 2 });
          if (fs.existsSync(x.path)) throw new Error('Часть файлов занята — закройте программу и повторите');
        } else {
          fs.rmSync(x.path, { force: true });
        }
        r.ok = true;
      } catch (e) { r.error = e.message; }
      results.push(r);
    }
    const okCount = results.filter((r) => r.ok).length;
    this.ctx.db.logCommand('local', 'ПК', 'leftovers', a.name, okCount === results.length, `удалено ${okCount} из ${results.length}`);
    this.leftovers.set(a.id, found.filter((x) => !results.find((r) => r.ok && r.path === x.path)));
    return results;
  }
}

module.exports = { AppsManager, parseCommand, cleanName, safeLeftoverDir, isProtectedName };
