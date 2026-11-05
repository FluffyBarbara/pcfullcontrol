'use strict';
// Питание: выключение, перезагрузка, сон, блокировка и т.д.
// Действия выполняются с задержкой в несколько секунд, чтобы ответ успел уйти в Telegram.
const os = require('os');
const { IS_WIN, IS_MAC, run, powershell } = require('./exec');

const DELAY_SEC = 3;
const later = (fn, sec = DELAY_SEC) => setTimeout(() => { Promise.resolve(fn()).catch(() => {}); }, sec * 1000);

function minutes(arg) {
  const s = String(arg ?? '').trim();
  if (!s) return 0;
  const n = Number(s.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new Error('Укажите задержку в минутах, например: 30');
  return Math.floor(n);
}

async function unixPower(kind, mins) {
  // kind: 'h' — выключение, 'r' — перезагрузка
  if (mins === 0) {
    later(async () => {
      if (IS_MAC) await run('sudo', ['-n', 'shutdown', `-${kind}`, 'now']);
      else if ((await run('systemctl', [kind === 'h' ? 'poweroff' : 'reboot'])).code !== 0) {
        await run('shutdown', [`-${kind}`, 'now']);
      }
    });
    return { code: 0, out: '' };
  }
  const args = [`-${kind}`, `+${mins}`];
  return IS_MAC ? run('sudo', ['-n', 'shutdown', ...args]) : run('shutdown', args);
}

async function shutdown(arg) {
  const mins = minutes(arg);
  const r = IS_WIN
    ? await run('shutdown.exe', ['/s', '/f', '/t', String(Math.max(mins * 60, DELAY_SEC))])
    : await unixPower('h', mins);
  if (r.code !== 0) throw new Error(r.out || 'не удалось выключить компьютер');
  return mins ? `Компьютер будет выключен через ${mins} мин.` : 'Выключаю компьютер…';
}

async function reboot(arg) {
  const mins = minutes(arg);
  const r = IS_WIN
    ? await run('shutdown.exe', ['/r', '/f', '/t', String(Math.max(mins * 60, DELAY_SEC))])
    : await unixPower('r', mins);
  if (r.code !== 0) throw new Error(r.out || 'не удалось перезагрузить компьютер');
  return mins ? `Перезагрузка через ${mins} мин.` : 'Перезагружаю компьютер…';
}

async function cancelShutdown() {
  const r = IS_WIN ? await run('shutdown.exe', ['/a']) : await run('shutdown', ['-c']);
  if (r.code !== 0) return 'Нет запланированного выключения (или его не удалось отменить).';
  return 'Запланированное выключение/перезагрузка отменены.';
}

async function sleep() {
  later(() => {
    if (IS_WIN) {
      return powershell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)");
    }
    return IS_MAC ? run('pmset', ['sleepnow']) : run('systemctl', ['suspend']);
  });
  return 'Перевожу компьютер в спящий режим…';
}

async function hibernate() {
  later(() => (IS_WIN ? run('shutdown.exe', ['/h']) : IS_MAC ? run('pmset', ['sleepnow']) : run('systemctl', ['hibernate'])));
  return 'Перевожу компьютер в гибернацию…';
}

async function lock() {
  if (IS_WIN) {
    await run('rundll32.exe', ['user32.dll,LockWorkStation']);
  } else if (IS_MAC) {
    await run('pmset', ['displaysleepnow']);
  } else {
    const r = await run('loginctl', ['lock-sessions']);
    if (r.code !== 0) throw new Error(r.out || 'не удалось заблокировать экран');
  }
  return 'Экран заблокирован 🔒';
}

async function logoff() {
  later(() => (IS_WIN ? run('shutdown.exe', ['/l'])
    : IS_MAC ? run('osascript', ['-e', 'tell application "System Events" to log out'])
      : run('loginctl', ['terminate-user', os.userInfo().username])));
  return 'Выполняю выход из системы…';
}

async function monitorOff() {
  if (IS_WIN) {
    await powershell(`Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern int PostMessage(int h, int m, int w, int l);'; [W.U]::PostMessage(0xffff, 0x0112, 0xF170, 2)`, 20000);
  } else if (IS_MAC) {
    await run('pmset', ['displaysleepnow']);
  } else {
    await run('xset', ['dpms', 'force', 'off']);
  }
  return 'Экран выключен 🌑';
}

module.exports = { shutdown, reboot, cancelShutdown, sleep, hibernate, lock, logoff, monitorOff, minutes };
