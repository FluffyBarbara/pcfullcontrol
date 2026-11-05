'use strict';
// Информация о системе (через systeminformation и модуль os).
const os = require('os');
const si = require('systeminformation');

const E = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  n = Number(n);
  while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (d ? d + ' д ' : '') + (h ? h + ' ч ' : '') + m + ' мин';
}

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function localIps() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && !a.address.startsWith('169.254.')) ips.push(a.address);
    }
  }
  return ips;
}

async function publicIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const t = (await r.text()).trim();
      if (r.ok && t) return t;
    } catch (e) { /* следующий сервис */ }
  }
  return null;
}

// --- кэшируемые медленные запросы ---
const cache = {};
async function cached(key, ttlMs, fn, fallback) {
  const c = cache[key];
  if (c && Date.now() - c.t < ttlMs) return c.v;
  let v;
  try { v = await fn(); } catch (e) { v = fallback; }
  cache[key] = { t: Date.now(), v };
  return v;
}

async function osDescription() {
  return cached('os', 24 * 3600e3, async () => {
    const o = await si.osInfo();
    return `${o.distro} ${o.release}`.trim();
  }, `${os.type()} ${os.release()}`);
}

async function cpuTemperature() {
  // В Windows датчик часто недоступен — тогда переспрашиваем раз в 10 минут
  const c = cache.temp;
  const ttl = c && c.v === null ? 600e3 : 20e3;
  return cached('temp', ttl, async () => {
    const t = await si.cpuTemperature();
    const v = t.main || t.max;
    return typeof v === 'number' && v > 0 ? v : null;
  }, null);
}

async function gpus() {
  return cached('gpu', 30e3, async () => {
    const g = await si.graphics();
    return (g.controllers || [])
      .filter((c) => c.utilizationGpu !== undefined && c.utilizationGpu !== null)
      .map((c) => ({
        name: c.model, util: c.utilizationGpu, temp: c.temperatureGpu ?? null,
        memUsed: (c.memoryUsed || 0) * 1024 * 1024, memTotal: (c.memoryTotal || 0) * 1024 * 1024,
      }));
  }, []);
}

async function disks() {
  return cached('disks', 15e3, async () => {
    const list = await si.fsSize();
    return list
      .filter((d) => d.size > 0 && !/^\/(snap|boot|var\/lib\/docker)/.test(d.mount) && !/squashfs|overlay/.test(d.type || ''))
      .map((d) => ({ mount: d.mount, fs: d.type, total: d.size, used: d.used, free: d.available ?? d.size - d.used, percent: d.use }));
  }, []);
}

async function battery() {
  try {
    const b = await si.battery();
    if (!b.hasBattery) return null;
    return { percent: Math.round(b.percent), plugged: !!b.acConnected, minutesLeft: b.timeRemaining > 0 ? b.timeRemaining : null };
  } catch (e) {
    return null;
  }
}

async function users() {
  return cached('users', 10e3, async () => {
    const u = await si.users();
    return [...new Set(u.map((x) => x.user).filter(Boolean))];
  }, []);
}

async function getStatus() {
  const [load, mem, dsk, bat, temp, osd, gpu, usr] = await Promise.all([
    si.currentLoad().catch(() => ({ currentLoad: 0, cpus: [] })),
    si.mem().catch(() => ({ total: os.totalmem(), available: os.freemem() })),
    disks(), battery(), cpuTemperature(), osDescription(), gpus(), users(),
  ]);
  const cpus = os.cpus();
  const used = mem.total - (mem.available ?? mem.free);
  const uptime = os.uptime();
  return {
    hostname: os.hostname(),
    os: osd,
    uptime,
    bootTime: Date.now() / 1000 - uptime,
    cpu: {
      percent: Math.round((load.currentLoad || 0) * 10) / 10,
      model: cpus[0] ? cpus[0].model.trim() : '',
      threads: cpus.length,
      mhz: cpus[0] ? cpus[0].speed : null,
    },
    ram: { total: mem.total, used, percent: Math.round((used / mem.total) * 1000) / 10 },
    disks: dsk,
    battery: bat,
    temp,
    gpus: gpu,
    users: usr,
    ips: localIps(),
  };
}

function bar(percent, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

function formatStatus(s, pcName = '') {
  const lines = [
    `🖥 <b>${E(pcName || s.hostname)}</b> — ${E(s.os)}`,
    `⏱ Работает: ${fmtDuration(s.uptime)} (с ${fmtDate(s.bootTime)})`,
    '',
    `🧠 CPU: <b>${s.cpu.percent.toFixed(0)}%</b> ${bar(s.cpu.percent)} (${s.cpu.threads} потоков)`,
    `💾 RAM: <b>${s.ram.percent.toFixed(0)}%</b> ${bar(s.ram.percent)} ${fmtBytes(s.ram.used)} / ${fmtBytes(s.ram.total)}`,
  ];
  if (s.temp !== null && s.temp !== undefined) lines.push(`🌡 Температура CPU: <b>${Math.round(s.temp)}°C</b>`);
  for (const g of s.gpus || []) {
    lines.push(`🎮 ${E(g.name)}: ${Math.round(g.util)}%` + (g.temp !== null ? `, ${Math.round(g.temp)}°C` : '')
      + (g.memTotal ? `, ${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}` : ''));
  }
  lines.push('');
  for (const d of s.disks) {
    lines.push(`💽 ${E(d.mount)} ${bar(d.percent)} свободно ${fmtBytes(d.free)} из ${fmtBytes(d.total)}`);
  }
  if (s.battery) {
    const b = s.battery;
    const st = b.plugged ? '🔌 заряжается' : '🔋 от батареи';
    const left = !b.plugged && b.minutesLeft ? `, осталось ${fmtDuration(b.minutesLeft * 60)}` : '';
    lines.push(`🔋 Батарея: ${b.percent}% (${st}${left})`);
  }
  lines.push('');
  lines.push(`🌐 IP: ${E(s.ips.join(', ') || '—')}`);
  lines.push(`👤 Пользователи: ${E(s.users.join(', ') || '—')}`);
  return lines.join('\n');
}

module.exports = {
  E, fmtBytes, fmtDuration, fmtDate, localIps, publicIp, getStatus, formatStatus,
  disks, battery, cpuTemperature, users, osDescription,
};
