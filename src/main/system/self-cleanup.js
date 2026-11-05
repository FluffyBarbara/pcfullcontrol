'use strict';
// Уборка после обновления PC Full Control (выполняется автоматически один раз после установки новой версии):
//  • кэш загрузки обновлений (установщик уже не нужен);
//  • кэши старой версии (код страниц, видеокарта) — программа создаст новые;
//  • старые копии программы, установленные ранее в другие папки (и их записи в списке программ);
//  • скачанные ранее установщики PCFullControl-Setup*.exe / PCControl-Android*.apk в «Загрузках» и на рабочем столе.
// Удаляются только файлы самой программы PC Full Control — по точным именам и проверкам.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WIN, powershell, run } = require('./exec');
const { OWN_INSTALLER_RE } = require('./cleaner');

const env = (k, d = '') => process.env[k] || d;
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();

function sizeOf(p) {
  let size = 0;
  const stack = [p];
  while (stack.length) {
    const x = stack.pop();
    let st;
    try { st = fs.lstatSync(x); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) { try { for (const n of fs.readdirSync(x)) stack.push(path.join(x, n)); } catch (e) { /* нет доступа */ } } else size += st.size;
  }
  return size;
}

function removePath(p) {
  const size = sizeOf(p);
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 });
  return fs.existsSync(p) ? 0 : size;
}

/** Похоже ли содержимое папки на установленную копию PC Full Control. */
function isOurInstall(dir) {
  // Смотрим список файлов, а не existsSync: Electron по-особому обрабатывает пути к *.asar
  try {
    const top = fs.readdirSync(dir).map((n) => n.toLowerCase());
    const hasExe = top.includes('pcfullcontrol.exe') || top.includes('pc full control.exe');
    const res = top.includes('resources') ? fs.readdirSync(path.join(dir, 'resources')).map((n) => n.toLowerCase()) : [];
    return hasExe && (res.includes('app.asar') || res.includes('app'));
  } catch (e) { return false; }
}

async function ourUninstallEntries() {
  if (!IS_WIN) return [];
  const r = await powershell(`
$paths = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$o = Get-ItemProperty $paths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'PC Full Control*' } | ForEach-Object {
  [pscustomobject]@{ key = ($_.PSPath -replace '^Microsoft\\.PowerShell\\.Core\\\\Registry::', ''); location = [string]$_.InstallLocation; uninstall = [string]$_.UninstallString } }
ConvertTo-Json -InputObject @($o) -Compress`, 30000);
  try {
    const v = JSON.parse(r.out || '[]');
    return Array.isArray(v) ? v : [v];
  } catch (e) { return []; }
}

/**
 * @param {{ exeDir: string, electronSession?: any, dataDir?: string }} opts
 * @returns {Promise<{ items: {what:string, freed:number}[], total:number }>}
 */
async function cleanupAfterUpdate({ exeDir, electronSession = null, dataDir = null, log = () => {} } = {}) {
  const items = [];
  const add = (what, freed) => { items.push({ what, freed }); log(`уборка: ${what} (${freed} байт)`); };
  log(`уборка после обновления: папка программы ${exeDir}`);

  // 1. Кэш загрузки обновлений
  const upd = path.join(env('LOCALAPPDATA', path.join(os.homedir(), 'AppData', 'Local')), 'pc-full-control-updater');
  if (fs.existsSync(upd)) {
    try { add('Загруженный установщик обновления', removePath(upd)); } catch (e) { /* занят */ }
  }

  if (dataDir) {
    for (const f of ['elevate-attempt', 'show-window.flag']) { try { fs.rmSync(path.join(dataDir, f), { force: true }); } catch (e) { /* ignore */ } }
    // Журнал обновлений: оставляем последние 300 строк
    try {
      const log = path.join(dataDir, 'update.log');
      const lines = fs.readFileSync(log, 'utf8').split('\n');
      if (lines.length > 300) fs.writeFileSync(log, lines.slice(-300).join('\n'));
    } catch (e) { /* журнала нет */ }
  }

  if (IS_WIN && exeDir) {
    const current = norm(exeDir);
    // 3. Старые копии программы в других папках
    const candidates = new Set([
      path.join(env('ProgramFiles', 'C:\\Program Files'), 'PC Full Control'), path.join(env('ProgramFiles', 'C:\\Program Files'), 'PCFullControl'),
      path.join(env('ProgramFiles(x86)', 'C:\\Program Files (x86)'), 'PC Full Control'), path.join(env('ProgramFiles(x86)', 'C:\\Program Files (x86)'), 'PCFullControl'),
      path.join(env('LOCALAPPDATA'), 'Programs', 'pc-full-control'), path.join(env('LOCALAPPDATA'), 'Programs', 'PC Full Control'), path.join(env('LOCALAPPDATA'), 'Programs', 'PCFullControl'),
    ]);
    const entries = await ourUninstallEntries();
    for (const e of entries) if (e.location) candidates.add(e.location.replace(/^"|"$/g, ''));
    const removedDirs = [];
    for (const dir of candidates) {
      if (!dir || norm(dir) === current || !fs.existsSync(dir)) continue;
      if (!isOurInstall(dir)) { log(`уборка: ${dir} — не похоже на копию программы, пропускаю`); continue; }
      try {
        const freed = removePath(dir);
        if (!fs.existsSync(dir)) { removedDirs.push(norm(dir)); add(`Старая копия программы: ${dir}`, freed); } else log(`уборка: ${dir} занята`);
      } catch (e) { log(`уборка: ${dir} — ${e.message}`); }
    }
    // Записи «PC Full Control» в списке программ, которые указывают на удалённые или несуществующие папки
    for (const e of entries) {
      const loc = e.location ? norm(e.location.replace(/^"|"$/g, '')) : '';
      if (!loc || loc === current) continue;
      if (removedDirs.includes(loc) || !fs.existsSync(e.location.replace(/^"|"$/g, ''))) {
        const r = await run('reg.exe', ['delete', e.key, '/f'], { timeout: 15000 });
        if (r.code === 0) add('Лишняя запись в списке программ', 0);
      }
    }
  }

  // 4. Скачанные ранее установщики этой программы
  for (const dir of [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const n of names) {
      if (!OWN_INSTALLER_RE.test(n)) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile()) continue;
        fs.rmSync(f, { force: true });
        add(`Старый установщик: ${n}`, st.size);
      } catch (e) { /* занят */ }
    }
  }
  // 5. Кэши старой версии программы (в последнюю очередь и с ограничением по времени)
  if (electronSession) {
    const limit = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 5000))]);
    try {
      await limit(electronSession.clearCache());
      await limit(electronSession.clearCodeCaches({}));
      add('Кэш старой версии программы', 0);
    } catch (e) { log('уборка: кэш не очищен — ' + e.message); }
  }
  const total = items.reduce((s, x) => s + (x.freed || 0), 0);
  log(`уборка завершена: ${items.length} поз., ${total} байт`);
  return { items, total };
}

module.exports = { cleanupAfterUpdate, isOurInstall };
