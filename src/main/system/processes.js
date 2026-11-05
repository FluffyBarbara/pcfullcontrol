'use strict';
// Список процессов и их завершение.
const si = require('systeminformation');
const { IS_WIN, run } = require('./exec');

const PROTECTED = new Set([
  'system', 'system idle process', 'idle', 'registry', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
  'smss.exe', 'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe', 'memory compression',
  'systemd', 'init', 'kthreadd', 'launchd', 'kernel_task',
]);

async function listProcesses({ sort = 'cpu', limit = 30, query = '' } = {}) {
  const data = await si.processes();
  const q = String(query || '').toLowerCase().trim();
  let list = (data.list || [])
    .filter((p) => p.pid > 0)
    .map((p) => ({
      pid: p.pid,
      name: p.name || '?',
      cpu: Math.round((p.cpu || 0) * 10) / 10,
      mem: (p.memRss || 0) * 1024,
      user: p.user || '',
    }));
  if (q) list = list.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid) === q);
  const key = { mem: (p) => p.mem, name: (p) => p.name.toLowerCase(), cpu: (p) => p.cpu }[sort] || ((p) => p.cpu);
  list.sort((a, b) => (sort === 'name' ? (key(a) < key(b) ? -1 : 1) : key(b) - key(a)));
  return limit ? list.slice(0, limit) : list;
}

function isProtected(name, pid) {
  return pid <= 4 || pid === process.pid || PROTECTED.has(String(name || '').toLowerCase());
}

/** Завершить процесс по PID или имени (chrome / chrome.exe). */
async function kill(target) {
  target = String(target || '').trim();
  if (!target) throw new Error('Укажите PID или имя процесса');
  const all = (await si.processes()).list || [];
  let victims;
  if (/^\d+$/.test(target)) {
    victims = all.filter((p) => p.pid === Number(target));
  } else {
    const t = target.toLowerCase().replace(/\.exe$/, '');
    victims = all.filter((p) => (p.name || '').toLowerCase().replace(/\.exe$/, '') === t);
  }
  if (!victims.length) throw new Error(`Процесс «${target}» не найден`);
  const killed = [];
  const skipped = [];
  for (const p of victims) {
    if (isProtected(p.name, p.pid)) { skipped.push(`${p.name} (${p.pid}) — системный`); continue; }
    try {
      if (IS_WIN) {
        const r = await run('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { timeout: 15000 });
        if (r.code !== 0 && !/not found|не найден/i.test(r.out)) throw new Error(r.out || 'нет прав');
      } else {
        process.kill(p.pid, 'SIGTERM');
      }
      killed.push(`${p.name} (${p.pid})`);
    } catch (e) {
      skipped.push(`${p.name} (${p.pid}) — ${e.message.split('\n')[0]}`);
    }
  }
  let msg = '';
  if (killed.length) msg += 'Завершено: ' + killed.join(', ');
  if (skipped.length) msg += (msg ? '\n' : '') + 'Не удалось: ' + skipped.join(', ');
  if (!killed.length) throw new Error(msg || 'Ничего не завершено');
  return msg;
}

module.exports = { listProcesses, kill, isProtected };
