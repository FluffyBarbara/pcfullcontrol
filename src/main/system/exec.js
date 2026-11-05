'use strict';
// Запуск внешних команд и PowerShell-скриптов.
const { execFile, spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

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
    execFile(cmd, args, {
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
  return run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout });
}

/** Запустить процесс и не ждать его. */
function spawnDetached(cmd, args = [], opts = {}) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
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

module.exports = { IS_WIN, IS_MAC, run, powershell, spawnDetached, which, cleanOutput, decode, psQuote };
