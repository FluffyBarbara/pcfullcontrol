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
  }

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
}

module.exports = { Database, now };
