'use strict';
// Видеокарта: загрузка, температура, частоты, память, мощность, вентилятор (NVIDIA — через nvidia-smi,
// остальные — то, что отдаёт Windows), и кадры в секунду в играх через PresentMon (Intel, MIT).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const si = require('systeminformation');
const { IS_WIN, run } = require('./exec');

const FIELDS = ['name', 'temperature.gpu', 'utilization.gpu', 'utilization.memory', 'memory.used', 'memory.total',
  'clocks.gr', 'clocks.mem', 'clocks.max.gr', 'power.draw', 'power.limit', 'fan.speed', 'driver_version'];

let smiPath = undefined;
function findSmi() {
  if (smiPath !== undefined) return smiPath;
  const cands = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
  ];
  smiPath = cands.find((p) => fs.existsSync(p)) || (IS_WIN ? null : 'nvidia-smi');
  return smiPath;
}

const n = (v) => {
  const x = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};

/** Разбор строки CSV nvidia-smi (порядок как в FIELDS). */
function parseSmi(out) {
  return String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const c = line.split(',').map((x) => x.trim());
    return {
      vendor: 'NVIDIA', name: c[0], temp: n(c[1]), util: n(c[2]), memUtil: n(c[3]),
      memUsed: n(c[4]) != null ? n(c[4]) * 1048576 : null, memTotal: n(c[5]) != null ? n(c[5]) * 1048576 : null,
      clock: n(c[6]), memClock: n(c[7]), clockMax: n(c[8]), power: n(c[9]), powerLimit: n(c[10]), fan: n(c[11]), driver: c[12] || '',
    };
  }).filter((g) => g.name);
}

async function gpuStats() {
  const smi = findSmi();
  if (smi) {
    const r = await run(smi, [`--query-gpu=${FIELDS.join(',')}`, '--format=csv,noheader,nounits'], { timeout: 10000 });
    if (r.code === 0) {
      const g = parseSmi(r.out);
      if (g.length) return g;
    }
  }
  // Другие видеокарты: что известно Windows
  try {
    const gr = await si.graphics();
    return (gr.controllers || []).filter((c) => c.model).map((c) => ({
      vendor: c.vendor || '', name: c.model, temp: c.temperatureGpu ?? null, util: c.utilizationGpu ?? null, memUtil: c.utilizationMemory ?? null,
      memUsed: c.memoryUsed != null ? c.memoryUsed * 1048576 : null, memTotal: c.vram ? c.vram * 1048576 : null,
      clock: c.clockCore ?? null, memClock: c.clockMemory ?? null, clockMax: null, power: c.powerDraw ?? null, powerLimit: c.powerLimit ?? null,
      fan: c.fanSpeed ?? null, driver: c.driverVersion || '',
    }));
  } catch (e) { return []; }
}

// ---------------- кадры в секунду (PresentMon) ----------------
const IGNORE_FPS = /^(dwm|explorer|pcfullcontrol|electron|textinputhost|searchhost|startmenuexperiencehost|shellexperiencehost|applicationframehost|systemsettings|chrome|msedge|firefox|opera|yandex|brave|discord|telegram|steamwebhelper|nvcontainer|nvidia.*)\.exe$/i;

/** Разбор CSV PresentMon: имя процесса и время между кадрами (мс). Поддерживает v1 и v2. */
function parsePresentHeader(line) {
  const cols = line.split(',').map((c) => c.trim());
  const idx = (names) => cols.findIndex((c) => names.includes(c));
  return {
    app: idx(['Application', 'ProcessName']),
    pid: idx(['ProcessID', 'ProcessId']),
    ms: idx(['MsBetweenPresents', 'msBetweenPresents', 'FrameTime', 'MsBetweenAppStart']),
    displayed: idx(['MsBetweenDisplayChange', 'msBetweenDisplayChange', 'DisplayedTime']),
  };
}

class FpsMonitor {
  constructor({ exePath, log = () => {} } = {}) {
    this.exePath = exePath;
    this.log = log;
    this.proc = null;
    this.frames = new Map(); // app -> [{t, ms}]
    this.stopTimer = null;
    this.error = '';
  }

  get available() { return IS_WIN && !!this.exePath && fs.existsSync(this.exePath); }

  /** Запускает PresentMon (если ещё не запущен) и держит его ещё 90 секунд после последнего запроса. */
  touch() {
    if (!this.available) return false;
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => this.stop(), 90000);
    if (this.proc) return true;
    const args = ['--output_stdout', '--stop_existing_session', '--session_name', 'PCFullControl', '--no_console_stats', '--v1_metrics'];
    const p = spawn(this.exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.error = '';
    let header = null;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!header) { if (/Application|ProcessName/.test(line)) header = parsePresentHeader(line); continue; }
        this.onLine(line, header);
      }
    });
    p.stderr.on('data', (d) => { this.error = String(d).trim().slice(0, 300); });
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = null;
      if (code) this.log(`PresentMon завершился с кодом ${code}: ${this.error}`);
    });
    p.on('error', (e) => { this.error = e.message; this.proc = null; });
    return true;
  }

  onLine(line, h) {
    const c = line.split(',');
    const app = c[h.app];
    const ms = parseFloat(c[h.ms]);
    if (!app || !(ms > 0) || ms > 1000) return;
    const now = Date.now();
    let arr = this.frames.get(app);
    if (!arr) { arr = []; this.frames.set(app, arr); }
    arr.push({ t: now, ms });
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
  }

  /** Кадры в секунду по приложениям за последние 2 секунды, самое «игровое» — первым. */
  current() {
    const now = Date.now();
    const out = [];
    for (const [app, arr] of this.frames) {
      const recent = arr.filter((f) => now - f.t < 2000);
      if (recent.length < 5) { if (!recent.length) this.frames.delete(app); continue; }
      const avg = recent.reduce((s, f) => s + f.ms, 0) / recent.length;
      const sorted = recent.map((f) => f.ms).sort((a, b) => b - a);
      const low1 = sorted[Math.floor(sorted.length * 0.01)] || sorted[0];
      out.push({ app, fps: Math.round(1000 / avg), low1: Math.round(1000 / low1), frames: recent.length, ignored: IGNORE_FPS.test(app) });
    }
    out.sort((a, b) => (a.ignored - b.ignored) || (b.frames - a.frames));
    return out;
  }

  stop() {
    clearTimeout(this.stopTimer);
    if (this.proc) { try { this.proc.kill(); } catch (e) { /* ignore */ } }
    this.proc = null;
    this.frames.clear();
  }
}

module.exports = { gpuStats, parseSmi, FpsMonitor, parsePresentHeader, FIELDS };
