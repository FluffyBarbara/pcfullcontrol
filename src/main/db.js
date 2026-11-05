'use strict';
// Локальная база данных SQLite (sql.js — SQLite, скомпилированный в WebAssembly, без облака).
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, level TEXT, category TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, source TEXT, user TEXT, action TEXT,
  arg TEXT, ok INTEGER, result TEXT);
CREATE TABLE IF NOT EXISTS metrics (
  ts REAL PRIMARY KEY, cpu REAL, ram REAL, disk REAL, temp REAL);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, arg TEXT DEFAULT '',
  kind TEXT NOT NULL, run_at REAL, time_of_day TEXT, weekdays TEXT DEFAULT '0,1,2,3,4,5,6',
  enabled INTEGER DEFAULT 1, last_run REAL, created REAL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, title TEXT, status TEXT,
  started REAL, finished REAL, output TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS tg_users (user_id INTEGER PRIMARY KEY, username TEXT, name TEXT, added REAL);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, platform TEXT, token_hash TEXT UNIQUE,
  created REAL, last_seen REAL, ip TEXT);
CREATE TABLE IF NOT EXISTS app_usage (day TEXT, name TEXT, seconds INTEGER DEFAULT 0, PRIMARY KEY (day, name));
CREATE TABLE IF NOT EXISTS outages (id INTEGER PRIMARY KEY AUTOINCREMENT, start REAL, end REAL);
CREATE TABLE IF NOT EXISTS speedtests (ts REAL PRIMARY KEY, down REAL, up REAL, ping REAL);
CREATE TABLE IF NOT EXISTS net_devices (mac TEXT PRIMARY KEY, ip TEXT, name TEXT, vendor TEXT, label TEXT, first_seen REAL, last_seen REAL);
CREATE TABLE IF NOT EXISTS gpu_metrics (ts REAL PRIMARY KEY, temp REAL, util REAL);
CREATE TABLE IF NOT EXISTS freed (ts REAL, bytes INTEGER, what TEXT);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_commands_ts ON commands(ts);
`;

const now = () => Date.now() / 1000;

class Database {
  constructor(SQL, file) {
    this.file = file;
    let data = null;
    if (file && fs.existsSync(file)) {
      try { data = fs.readFileSync(file); } catch (e) { data = null; }
    }
    try {
      this.db = data ? new SQL.Database(data) : new SQL.Database();
      this.db.exec('SELECT 1 FROM sqlite_master LIMIT 1');
    } catch (e) {
      // Повреждённый файл — сохраняем копию и начинаем с чистой базы
      if (file) fs.copyFileSync(file, file + '.broken-' + Date.now());
      this.db = new SQL.Database();
    }
    this.db.exec(SCHEMA);
    this._timer = null;
    this.save();
  }

  static async open(file) {
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    const SQL = await initSqlJs({ wasmBinary });
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
    return new Database(SQL, file);
  }

  // ---------- базовые операции ----------
  run(sql, params = []) {
    this.db.run(sql, params);
    const changes = this.db.getRowsModified();
    this._dirty();
    return changes;
  }

  insert(sql, params = []) {
    this.db.run(sql, params);
    const id = this.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    this._dirty();
    return Number(id);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  _dirty() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.save(); }, 3000);
  }

  /** Атомарная запись базы на диск. */
  save() {
    if (!this.file) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.file);
  }

  close() {
    this.save();
    this.db.close();
  }

  // ---------- настройки ----------
  getSetting(key, def = null) {
    const row = this.get('SELECT value FROM settings WHERE key=?', [key]);
    if (!row) return def;
    try { return JSON.parse(row.value); } catch (e) { return row.value; }
  }

  setSetting(key, value) {
    this.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      [key, JSON.stringify(value === undefined ? null : value)]);
  }

  // ---------- журнал ----------
  addEvent(level, category, message) {
    this.run('INSERT INTO events(ts, level, category, message) VALUES(?,?,?,?)',
      [now(), level, category, String(message).slice(0, 2000)]);
  }

  recentEvents(limit = 50) {
    return this.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', [limit]);
  }

  logCommand(source, user, action, arg, ok, result) {
    this.run('INSERT INTO commands(ts, source, user, action, arg, ok, result) VALUES(?,?,?,?,?,?,?)',
      [now(), source, user || '', action, arg || '', ok ? 1 : 0, String(result || '').slice(0, 2000)]);
  }

  recentCommands(limit = 50) {
    return this.all('SELECT * FROM commands ORDER BY id DESC LIMIT ?', [limit]);
  }

  // ---------- метрики ----------
  addMetrics(cpu, ram, disk, temp) {
    this.run('INSERT OR REPLACE INTO metrics(ts, cpu, ram, disk, temp) VALUES(?,?,?,?,?)',
      [now(), cpu, ram, disk, temp === undefined ? null : temp]);
  }

  metricsSince(ts) {
    return this.all('SELECT * FROM metrics WHERE ts>=? ORDER BY ts', [ts]);
  }

  prune(metricsDays = 7, eventsDays = 60) {
    const t = now();
    this.run('DELETE FROM metrics WHERE ts<?', [t - metricsDays * 86400]);
    this.run('DELETE FROM events WHERE ts<?', [t - eventsDays * 86400]);
    this.run('DELETE FROM commands WHERE ts<?', [t - eventsDays * 86400]);
    this.run('DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT 50)');
    this.run('DELETE FROM gpu_metrics WHERE ts<?', [t - 14 * 86400]);
    this.run('DELETE FROM outages WHERE start<?', [t - 90 * 86400]);
    this.run('DELETE FROM speedtests WHERE ts<?', [t - 90 * 86400]);
    this.run('DELETE FROM freed WHERE ts<?', [t - 90 * 86400]);
    const old = new Date((t - 60 * 86400) * 1000).toISOString().slice(0, 10);
    this.run('DELETE FROM app_usage WHERE day<?', [old]);
  }

  // ---------- статистика для отчётов ----------
  addAppUsage(day, name, seconds) {
    this.run('INSERT INTO app_usage(day, name, seconds) VALUES (?,?,?) ON CONFLICT(day, name) DO UPDATE SET seconds = seconds + excluded.seconds', [day, name, seconds]);
  }
  appUsageSince(day) {
    return this.all('SELECT name, SUM(seconds) AS seconds FROM app_usage WHERE day >= ? GROUP BY name ORDER BY seconds DESC', [day]);
  }
  addOutage(start, end) { return this.insert('INSERT INTO outages(start, end) VALUES (?,?)', [start, end]); }
  outagesSince(ts) { return this.all('SELECT * FROM outages WHERE start >= ? ORDER BY start DESC', [ts]); }
  addSpeedtest(r) { this.run('INSERT OR REPLACE INTO speedtests(ts, down, up, ping) VALUES (?,?,?,?)', [r.ts, r.down, r.up, r.ping]); }
  speedtestsSince(ts) { return this.all('SELECT * FROM speedtests WHERE ts >= ? ORDER BY ts DESC', [ts]); }
  lastSpeedtest() { return this.get('SELECT * FROM speedtests ORDER BY ts DESC LIMIT 1'); }
  netDevices() { return this.all('SELECT * FROM net_devices ORDER BY last_seen DESC'); }
  upsertNetDevice(d) {
    const t = now();
    const ex = this.get('SELECT mac FROM net_devices WHERE mac=?', [d.mac]);
    if (ex) this.run('UPDATE net_devices SET ip=?, name=COALESCE(NULLIF(?, \'\'), name), vendor=?, last_seen=? WHERE mac=?', [d.ip, d.name || '', d.vendor || '', t, d.mac]);
    else this.run('INSERT INTO net_devices(mac, ip, name, vendor, label, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)', [d.mac, d.ip, d.name || '', d.vendor || '', '', t, t]);
    return !ex;
  }
  labelNetDevice(mac, label) { return this.run('UPDATE net_devices SET label=? WHERE mac=?', [String(label || '').slice(0, 60), mac]) > 0; }
  addGpuMetrics(temp, util) { this.run('INSERT OR REPLACE INTO gpu_metrics(ts, temp, util) VALUES (?,?,?)', [now(), temp, util]); }
  gpuMetricsSince(ts) { return this.all('SELECT * FROM gpu_metrics WHERE ts >= ? ORDER BY ts', [ts]); }
  addFreed(bytes, what) { this.run('INSERT INTO freed(ts, bytes, what) VALUES (?,?,?)', [now(), Math.round(bytes) || 0, what]); }
  freedSince(ts) { return (this.get('SELECT COALESCE(SUM(bytes), 0) AS b FROM freed WHERE ts >= ?', [ts]) || {}).b || 0; }
  eventsSince(ts) { return this.all('SELECT * FROM events WHERE ts >= ? ORDER BY ts', [ts]); }
  commandsSince(ts) { return this.all('SELECT * FROM commands WHERE ts >= ? ORDER BY ts', [ts]); }

  // ---------- задачи ----------
  addTask({ action, arg = '', kind, runAt = null, timeOfDay = null, weekdays = '0,1,2,3,4,5,6' }) {
    return this.insert(
      'INSERT INTO tasks(action, arg, kind, run_at, time_of_day, weekdays, enabled, created) VALUES(?,?,?,?,?,?,1,?)',
      [action, arg || '', kind, runAt, timeOfDay, weekdays, now()]);
  }

  listTasks(onlyEnabled = false) {
    return this.all('SELECT * FROM tasks' + (onlyEnabled ? ' WHERE enabled=1' : '') + ' ORDER BY id');
  }

  getTask(id) { return this.get('SELECT * FROM tasks WHERE id=?', [id]); }
  deleteTask(id) { return this.run('DELETE FROM tasks WHERE id=?', [id]) > 0; }
  setTaskEnabled(id, enabled) { this.run('UPDATE tasks SET enabled=? WHERE id=?', [enabled ? 1 : 0, id]); }
  markTaskRun(id, ts) { this.run('UPDATE tasks SET last_run=? WHERE id=?', [ts, id]); }

  // ---------- фоновые задания ----------
  createJob(kind, title) {
    return this.insert("INSERT INTO jobs(kind, title, status, started) VALUES(?,?,'running',?)", [kind, title, now()]);
  }

  finishJob(id, status, output) {
    this.run('UPDATE jobs SET status=?, finished=?, output=? WHERE id=?', [status, now(), output, id]);
  }

  getJob(id) { return this.get('SELECT * FROM jobs WHERE id=?', [id]); }

  runningJob(kind) {
    return this.get("SELECT * FROM jobs WHERE kind=? AND status='running' ORDER BY id DESC LIMIT 1", [kind]);
  }

  recentJobs(limit = 20) { return this.all('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', [limit]); }

  failStaleJobs() {
    this.run("UPDATE jobs SET status='error', finished=?, output=output || '\n[прервано перезапуском]' WHERE status='running'", [now()]);
  }

  // ---------- пользователи Telegram ----------
  addTgUser(userId, username = '', name = '') {
    this.run('INSERT OR REPLACE INTO tg_users(user_id, username, name, added) VALUES(?,?,?,?)',
      [userId, username, name, now()]);
  }

  removeTgUser(userId) { return this.run('DELETE FROM tg_users WHERE user_id=?', [userId]) > 0; }
  listTgUsers() { return this.all('SELECT * FROM tg_users ORDER BY added'); }

  // ---------- телефоны с приложением ----------
  addDevice(name, platform, tokenHash, ip) {
    return this.insert('INSERT INTO devices(name, platform, token_hash, created, last_seen, ip) VALUES(?,?,?,?,?,?)',
      [name, platform, tokenHash, now(), now(), ip]);
  }

  deviceByToken(tokenHash) { return this.get('SELECT * FROM devices WHERE token_hash=?', [tokenHash]); }

  touchDevice(id, ip) {
    // Без пометки «изменено»: last_seen обновляется часто, база сохранится вместе с другими изменениями
    this.db.run('UPDATE devices SET last_seen=?, ip=? WHERE id=?', [now(), ip, id]);
  }

  listDevices() { return this.all('SELECT id, name, platform, created, last_seen, ip FROM devices ORDER BY last_seen DESC'); }
  removeDevice(id) { return this.run('DELETE FROM devices WHERE id=?', [id]) > 0; }
}

module.exports = { Database, now };
