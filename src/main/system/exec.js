'use strict';
// Запуск внешних команд и PowerShell-скриптов.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Системные программы — по полному пути из папки Windows, а не через PATH: программа работает с правами
// администратора, и подложенный в PATH «powershell.exe» не должен запуститься вместо настоящего.
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
const PS_EXE = IS_WIN ? path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell';
const CMD_EXE = IS_WIN ? path.join(SYS32, 'cmd.exe') : 'sh';
const sysCache = new Map();
function sysPath(cmd) {
  if (!IS_WIN || /[\\/]/.test(cmd)) return cmd;
  if (sysCache.has(cmd)) return sysCache.get(cmd);
  let full = cmd;
  for (const name of /\.(exe|com)$/i.test(cmd) ? [cmd] : [cmd + '.exe', cmd]) {
    const p = path.join(SYS32, name);
    try { if (fs.statSync(p).isFile()) { full = p; break; } } catch (e) { /* нет в System32 */ }
  }
  sysCache.set(cmd, full);
  return full;
}

/**
 * Папка для скомпилированных помощников (DLL) и их скриптов. В установленной программе — рядом с ней
 * в Program Files: туда пишет только администратор, поэтому вредная программа без прав администратора
 * не подменит DLL, которую потом загрузит программа (она работает с правами администратора).
 */
let binDir = null;
function secureBinDir(dataDir) {
  if (binDir) return binDir;
  const fallback = dataDir ? path.join(dataDir, 'bin') : require('os').tmpdir();
  if (!IS_WIN) return (binDir = fallback);
  const dir = path.join(path.dirname(process.execPath), 'cache');
  const pf = [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean).map((x) => x.toLowerCase());
  if (!pf.some((x) => dir.toLowerCase().startsWith(x + '\\'))) return (binDir = fallback);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    // Старая папка помощников в данных пользователя больше не нужна
    if (dataDir) { try { fs.rmSync(path.join(dataDir, 'bin'), { recursive: true, force: true }); } catch (e) { /* занята */ } }
    return (binDir = dir);
  } catch (e) {
    return (binDir = fallback); // программа запущена без прав администратора
  }
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SPINNER_RE = /^[\s\-\\|/█▒░■□▓]*$/;

function decode(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    for (const enc of ['ibm866', 'windows-1251']) {
      try { return new TextDecoder(enc).decode(buf); } catch (e2) { /* следующая кодировка */ }
    }
    return buf.toString('latin1');
  }
}

// Убирает ANSI-коды, строки прогресса (\r) и спиннеры winget/apt.
function cleanOutput(text) {
  const lines = [];
  for (const raw of String(text).replace(ANSI_RE, '').split('\n')) {
    const parts = raw.replace(/\r+$/, '').split('\r');
    const line = parts[parts.length - 1].trimEnd();
    if (line && SPINNER_RE.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Запустить команду и вернуть { code, out }. Никогда не бросает исключений. */
function run(cmd, args = [], { timeout = 60000, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(sysPath(cmd), args, {
      timeout, cwd, windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let out = cleanOutput(decode(Buffer.concat([stdout || Buffer.alloc(0), stderr || Buffer.alloc(0)])));
      let code = 0;
      if (err) {
        if (err.code === 'ENOENT') return resolve({ code: -1, out: `Команда не найдена: ${cmd}` });
        code = typeof err.code === 'number' ? err.code : -1;
        if (err.killed) out += `\n[превышено время ожидания: ${Math.round(timeout / 1000)} с]`;
      }
      resolve({ code, out });
    });
  });
}

/** PowerShell-скрипт через -EncodedCommand (без проблем с кавычками и кириллицей). */
function powershell(script, timeout = 120000) {
  const full = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; " + script;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  return run(PS_EXE,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout });
}

/** Запустить процесс и не ждать его. */
function spawnDetached(cmd, args = [], opts = {}) {
  const child = spawn(sysPath(cmd), args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  child.on('error', () => {});
  child.unref();
}

async function which(name) {
  const r = IS_WIN ? await run('where.exe', [name], { timeout: 10000 }) : await run('which', [name], { timeout: 10000 });
  if (r.code !== 0) return null;
  return r.out.split(/\r?\n/)[0].trim() || null;
}

/** Экранирование строки для PowerShell в одинарных кавычках. */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

module.exports = { IS_WIN, IS_MAC, run, powershell, spawnDetached, which, cleanOutput, decode, psQuote, PS_EXE, CMD_EXE, sysPath, secureBinDir };
