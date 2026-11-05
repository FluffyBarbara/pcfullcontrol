"""Локальная база данных SQLite. Никаких облачных сервисов."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created    REAL,
    expires    REAL,
    last_seen  REAL,
    ip         TEXT,
    user_agent TEXT
);
CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT,
    ts REAL
);
CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL,
    level    TEXT,
    category TEXT,
    message  TEXT
);
CREATE TABLE IF NOT EXISTS commands (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     REAL,
    source TEXT,
    user   TEXT,
    action TEXT,
    arg    TEXT,
    ok     INTEGER,
    result TEXT
);
CREATE TABLE IF NOT EXISTS metrics (
    ts   REAL PRIMARY KEY,
    cpu  REAL,
    ram  REAL,
    disk REAL,
    temp REAL,
    net_sent REAL,
    net_recv REAL
);
CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    arg         TEXT DEFAULT '',
    kind        TEXT NOT NULL,          -- once | daily
    run_at      REAL,                   -- для once
    time_of_day TEXT,                   -- для daily, "HH:MM"
    weekdays    TEXT DEFAULT '0,1,2,3,4,5,6',
    enabled     INTEGER DEFAULT 1,
    last_run    REAL,
    created     REAL,
    note        TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS jobs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    kind     TEXT,
    title    TEXT,
    status   TEXT,                      -- running | done | error
    started  REAL,
    finished REAL,
    output   TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tg_users (
    user_id  INTEGER PRIMARY KEY,
    username TEXT,
    added    REAL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_commands_ts ON commands(ts);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, ts);
"""


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        with self._lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.executescript(SCHEMA)

    # ---------- базовые операции ----------
    def execute(self, sql: str, params: tuple | list = ()) -> int:
        """Выполнить запрос, вернуть число затронутых строк."""
        with self._lock:
            return self.conn.execute(sql, params).rowcount

    def insert(self, sql: str, params: tuple | list = ()) -> int:
        """Выполнить INSERT, вернуть id новой строки."""
        with self._lock:
            return int(self.conn.execute(sql, params).lastrowid)

    def query(self, sql: str, params: tuple | list = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def query_one(self, sql: str, params: tuple | list = ()) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    # ---------- настройки ----------
    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.query_one("SELECT value FROM settings WHERE key=?", (key,))
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, ValueError):
            return row["value"]

    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )

    # ---------- журнал событий ----------
    def add_event(self, level: str, category: str, message: str) -> None:
        self.execute(
            "INSERT INTO events(ts, level, category, message) VALUES(?,?,?,?)",
            (time.time(), level, category, message),
        )

    def recent_events(self, limit: int = 50, category: str | None = None) -> list[dict]:
        if category:
            return self.query(
                "SELECT * FROM events WHERE category=? ORDER BY id DESC LIMIT ?", (category, limit)
            )
        return self.query("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,))

    # ---------- история команд ----------
    def log_command(self, source: str, user: str, action: str, arg: str, ok: bool, result: str) -> None:
        self.execute(
            "INSERT INTO commands(ts, source, user, action, arg, ok, result) VALUES(?,?,?,?,?,?,?)",
            (time.time(), source, user, action, arg, int(ok), (result or "")[:2000]),
        )

    def recent_commands(self, limit: int = 50) -> list[dict]:
        return self.query("SELECT * FROM commands ORDER BY id DESC LIMIT ?", (limit,))

    # ---------- метрики ----------
    def add_metrics(self, cpu: float, ram: float, disk: float, temp: float | None,
                    net_sent: float, net_recv: float) -> None:
        self.execute(
            "INSERT OR REPLACE INTO metrics(ts, cpu, ram, disk, temp, net_sent, net_recv) "
            "VALUES(?,?,?,?,?,?,?)",
            (time.time(), cpu, ram, disk, temp, net_sent, net_recv),
        )

    def metrics_since(self, since_ts: float) -> list[dict]:
        return self.query("SELECT * FROM metrics WHERE ts>=? ORDER BY ts", (since_ts,))

    def prune(self, metrics_days: int, events_days: int = 60) -> None:
        now = time.time()
        self.execute("DELETE FROM metrics WHERE ts<?", (now - metrics_days * 86400,))
        self.execute("DELETE FROM events WHERE ts<?", (now - events_days * 86400,))
        self.execute("DELETE FROM commands WHERE ts<?", (now - events_days * 86400,))
        self.execute("DELETE FROM login_attempts WHERE ts<?", (now - 86400,))
        self.execute("DELETE FROM sessions WHERE expires<?", (now,))
        self.execute(
            "DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT 50)"
        )

    # ---------- задачи планировщика ----------
    def add_task(self, action: str, arg: str, kind: str, run_at: float | None = None,
                 time_of_day: str | None = None, weekdays: str = "0,1,2,3,4,5,6",
                 note: str = "") -> int:
        return self.insert(
            "INSERT INTO tasks(action, arg, kind, run_at, time_of_day, weekdays, enabled, created, note) "
            "VALUES(?,?,?,?,?,?,1,?,?)",
            (action, arg or "", kind, run_at, time_of_day, weekdays, time.time(), note),
        )

    def list_tasks(self, only_enabled: bool = False) -> list[dict]:
        sql = "SELECT * FROM tasks"
        if only_enabled:
            sql += " WHERE enabled=1"
        return self.query(sql + " ORDER BY id")

    def get_task(self, task_id: int) -> dict | None:
        return self.query_one("SELECT * FROM tasks WHERE id=?", (task_id,))

    def delete_task(self, task_id: int) -> bool:
        return self.execute("DELETE FROM tasks WHERE id=?", (task_id,)) > 0

    def set_task_enabled(self, task_id: int, enabled: bool) -> None:
        self.execute("UPDATE tasks SET enabled=? WHERE id=?", (int(enabled), task_id))

    def mark_task_run(self, task_id: int, ts: float) -> None:
        self.execute("UPDATE tasks SET last_run=? WHERE id=?", (ts, task_id))

    # ---------- фоновые задания ----------
    def create_job(self, kind: str, title: str) -> int:
        return self.insert(
            "INSERT INTO jobs(kind, title, status, started) VALUES(?,?, 'running', ?)",
            (kind, title, time.time()),
        )

    def finish_job(self, job_id: int, status: str, output: str) -> None:
        self.execute(
            "UPDATE jobs SET status=?, finished=?, output=? WHERE id=?",
            (status, time.time(), output, job_id),
        )

    def get_job(self, job_id: int) -> dict | None:
        return self.query_one("SELECT * FROM jobs WHERE id=?", (job_id,))

    def running_job(self, kind: str) -> dict | None:
        return self.query_one(
            "SELECT * FROM jobs WHERE kind=? AND status='running' ORDER BY id DESC LIMIT 1", (kind,)
        )

    def recent_jobs(self, limit: int = 20) -> list[dict]:
        return self.query("SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,))

    def fail_stale_jobs(self) -> None:
        """Задания, оставшиеся 'running' после перезапуска агента, помечаем как прерванные."""
        self.execute(
            "UPDATE jobs SET status='error', finished=?, output=output || '\n[прервано перезапуском]' "
            "WHERE status='running'",
            (time.time(),),
        )

    # ---------- пользователи Telegram ----------
    def add_tg_user(self, user_id: int, username: str = "") -> None:
        self.execute(
            "INSERT OR REPLACE INTO tg_users(user_id, username, added) VALUES(?,?,?)",
            (user_id, username, time.time()),
        )

    def remove_tg_user(self, user_id: int) -> bool:
        return self.execute("DELETE FROM tg_users WHERE user_id=?", (user_id,)) > 0

    def list_tg_users(self) -> list[dict]:
        return self.query("SELECT * FROM tg_users ORDER BY added")

    # ---------- сессии веб-панели ----------
    def add_session(self, token_hash: str, expires: float, ip: str, user_agent: str) -> None:
        now = time.time()
        self.execute(
            "INSERT INTO sessions(token_hash, created, expires, last_seen, ip, user_agent) "
            "VALUES(?,?,?,?,?,?)",
            (token_hash, now, expires, now, ip, user_agent[:300]),
        )

    def get_session(self, token_hash: str) -> dict | None:
        return self.query_one("SELECT * FROM sessions WHERE token_hash=?", (token_hash,))

    def touch_session(self, token_hash: str) -> None:
        self.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (time.time(), token_hash))

    def delete_session(self, token_hash: str) -> None:
        self.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))

    def delete_all_sessions(self) -> int:
        return self.execute("DELETE FROM sessions")

    def list_sessions(self) -> list[dict]:
        return self.query(
            "SELECT created, expires, last_seen, ip, user_agent FROM sessions "
            "WHERE expires>? ORDER BY last_seen DESC",
            (time.time(),),
        )

    def add_login_attempt(self, ip: str) -> None:
        self.execute("INSERT INTO login_attempts(ip, ts) VALUES(?,?)", (ip, time.time()))

    def count_login_attempts(self, ip: str, since: float) -> int:
        row = self.query_one(
            "SELECT COUNT(*) AS n FROM login_attempts WHERE ip=? AND ts>=?", (ip, since)
        )
        return int(row["n"]) if row else 0

    def clear_login_attempts(self, ip: str) -> None:
        self.execute("DELETE FROM login_attempts WHERE ip=?", (ip,))
