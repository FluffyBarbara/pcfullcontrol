import time
from datetime import datetime, timedelta

import pytest

from pcontrol.auth import LoginBlocked, hash_password, verify_password
from pcontrol.platform_utils import clean_output
from pcontrol.scheduler import is_due, parse_duration, parse_time, parse_weekdays


# ---------------- база и настройки ----------------
def test_settings_roundtrip(ctx):
    ctx.db.set_setting("x", {"a": 1})
    assert ctx.db.get_setting("x") == {"a": 1}
    assert ctx.db.get_setting("missing", 5) == 5


def test_delete_returns_rowcount(ctx):
    tid = ctx.db.add_task("lock", "", "once", run_at=time.time() + 100)
    assert tid > 0
    assert ctx.db.delete_task(tid) is True
    assert ctx.db.delete_task(tid) is False


# ---------------- пароль и вход ----------------
def test_password_hash():
    h = hash_password("secret123")
    assert verify_password("secret123", h)
    assert not verify_password("wrong", h)


def test_login_lockout(ctx):
    auth = ctx.web_auth
    auth.set_password("goodpass")
    for _ in range(auth.max_attempts):
        with pytest.raises(ValueError):
            auth.login("bad", "1.2.3.4")
    with pytest.raises(LoginBlocked):
        auth.login("goodpass", "1.2.3.4")
    token = auth.login("goodpass", "5.6.7.8")
    assert auth.validate(token)
    auth.logout(token)
    assert not auth.validate(token)


# ---------------- планировщик ----------------
def test_parsers():
    assert parse_time("23:30") == (23, 30)
    assert parse_duration("30") == 1800
    assert parse_duration("1h30m") == 5400
    assert parse_duration("2ч") == 7200
    assert parse_weekdays("пн-пт") == [0, 1, 2, 3, 4]
    assert parse_weekdays("сб,вс") == [5, 6]
    assert parse_weekdays("будни") == [0, 1, 2, 3, 4]
    assert parse_weekdays("shutdown") is None
    with pytest.raises(ValueError):
        parse_duration("abc")
    with pytest.raises(ValueError):
        parse_time("25:00")


def test_is_due_daily():
    now = datetime(2026, 11, 4, 23, 5)  # среда
    task = {"kind": "daily", "time_of_day": "23:00", "weekdays": "0,1,2,3,4", "last_run": None}
    assert is_due(task, now) == "run"
    task["last_run"] = now.timestamp()
    assert is_due(task, now) is None
    task = {"kind": "daily", "time_of_day": "23:00", "weekdays": "5,6", "last_run": None}
    assert is_due(task, now) is None
    task = {"kind": "daily", "time_of_day": "20:00", "weekdays": "0,1,2,3,4,5,6", "last_run": None}
    assert is_due(task, now) is None  # пропущено более чем на 30 минут


def test_is_due_once():
    now = datetime.now()
    assert is_due({"kind": "once", "run_at": (now - timedelta(minutes=1)).timestamp()}, now) == "run"
    assert is_due({"kind": "once", "run_at": (now - timedelta(hours=2)).timestamp()}, now) == "missed"
    assert is_due({"kind": "once", "run_at": (now + timedelta(minutes=1)).timestamp()}, now) is None


def test_scheduler_runs_task(ctx):
    tid = ctx.scheduler.add_once("notify", "Привет", time.time() - 5)
    ctx.scheduler.tick()
    task = ctx.db.get_task(tid)
    assert task["enabled"] == 0 and task["last_run"]
    assert ctx.db.recent_commands(1)[0]["action"] == "notify"


def test_default_update_task(ctx):
    ctx.scheduler._ensure_default_tasks()
    ctx.scheduler._ensure_default_tasks()
    tasks = ctx.db.list_tasks()
    assert len(tasks) == 1 and tasks[0]["action"] == "check_updates"


# ---------------- действия ----------------
def test_shell_disabled_by_default(ctx):
    ok, msg = ctx.actions.run("shell", "echo hi")
    assert not ok and "отключено" in msg


def test_shell_enabled(ctx):
    ctx.config["security"]["allow_shell"] = True
    ok, msg = ctx.actions.run("shell", "echo hi")
    assert ok and "hi" in msg


def test_arg_required(ctx):
    ok, msg = ctx.actions.run("kill", "")
    assert not ok and "параметр" in msg.lower()


def test_kill_missing_process(ctx):
    ok, msg = ctx.actions.run("kill", "definitely_not_running_process_xyz")
    assert not ok and "не найден" in msg


def test_unknown_action(ctx):
    ok, _ = ctx.actions.run("nope")
    assert not ok


def test_clean_output():
    raw = "Progress   \r  -  \r\\ \rDone\r\n\x1b[32mOK\x1b[0m\r\n"
    assert clean_output(raw) == "Done\nOK"


# ---------------- файлы ----------------
def test_file_manager_roots_restriction(tmp_path, ctx):
    from pcontrol.system.files import FileAccessError, FileManager

    allowed = tmp_path / "allowed"
    allowed.mkdir()
    (allowed / "a.txt").write_text("x")
    fm = FileManager([str(allowed)], tmp_path / "up")
    assert [e["name"] for e in fm.list_dir(str(allowed))] == ["a.txt"]
    with pytest.raises(FileAccessError):
        fm.list_dir(str(tmp_path))
    with pytest.raises(FileAccessError):
        fm.list_dir(str(allowed / ".." / ".."))
    assert fm.parent(str(allowed)) is None


def test_upload_no_overwrite(ctx):
    p1 = ctx.files.save_upload("../../evil.txt", b"1")
    p2 = ctx.files.save_upload("evil.txt", b"2")
    assert p1.parent == ctx.config.upload_dir and p1.name == "evil.txt"
    assert p1 != p2 and p1.read_bytes() == b"1"
