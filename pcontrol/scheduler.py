"""Планировщик задач: разовые («в 23:30», «через 30 мин») и ежедневные/по дням недели."""
from __future__ import annotations

import html
import logging
import re
import threading
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .core import AppContext

log = logging.getLogger(__name__)

DAILY_GRACE = timedelta(minutes=30)   # если ПК был выключен дольше — ежедневную задачу пропускаем
ONCE_GRACE = 10 * 60                  # разовую задачу, просроченную больше чем на 10 мин, не выполняем

WEEKDAY_NAMES = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
_WD_ALIASES = {
    "пн": 0, "вт": 1, "ср": 2, "чт": 3, "пт": 4, "сб": 5, "вс": 6,
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}


def parse_time(text: str) -> tuple[int, int]:
    m = re.fullmatch(r"\s*(\d{1,2})[:.](\d{2})\s*", text or "")
    if not m:
        raise ValueError("Время в формате ЧЧ:ММ, например 23:30")
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        raise ValueError("Неверное время")
    return h, mi


def parse_duration(text: str) -> int:
    """'30m', '2h', '1h30m', '90' (минуты), '1д', '45 мин', '30s' -> секунды."""
    t = (text or "").strip().lower().replace(" ", "")
    if not t:
        raise ValueError("Укажите время, например 30m или 2h")
    if t.isdigit():
        return int(t) * 60
    units = {"d": 86400, "д": 86400, "h": 3600, "ч": 3600, "m": 60, "м": 60, "мин": 60,
             "min": 60, "s": 1, "с": 1, "сек": 1, "sec": 1}
    total, pos = 0, 0
    for m in re.finditer(r"(\d+)(мин|min|сек|sec|d|д|h|ч|m|м|s|с)", t):
        if m.start() != pos:
            raise ValueError(f"Не понял длительность: {text}")
        total += int(m.group(1)) * units[m.group(2)]
        pos = m.end()
    if pos != len(t) or total <= 0:
        raise ValueError(f"Не понял длительность: {text}")
    return total


def parse_weekdays(text: str) -> list[int] | None:
    """'пн-пт', '1-5', 'сб,вс', 'будни', 'выходные' -> [0..6]. None — если это не дни недели."""
    t = (text or "").strip().lower()
    if t in ("будни", "weekdays"):
        return [0, 1, 2, 3, 4]
    if t in ("выходные", "weekend"):
        return [5, 6]
    if t in ("ежедневно", "каждый", "daily", "все"):
        return list(range(7))
    days: set[int] = set()
    for part in t.split(","):
        part = part.strip()
        if not part:
            continue
        bounds = part.split("-")
        if len(bounds) > 2:
            return None
        vals = []
        for b in bounds:
            if b in _WD_ALIASES:
                vals.append(_WD_ALIASES[b])
            elif b.isdigit() and 1 <= int(b) <= 7:
                vals.append(int(b) - 1)
            else:
                return None
        if len(vals) == 1:
            days.add(vals[0])
        else:
            a, b = vals
            rng = range(a, b + 1) if a <= b else list(range(a, 7)) + list(range(0, b + 1))
            days.update(rng)
    return sorted(days) if days else None


def weekdays_str(days: list[int]) -> str:
    return ",".join(str(d) for d in sorted(set(days)))


def describe_weekdays(spec: str) -> str:
    days = sorted(int(x) for x in (spec or "").split(",") if x.strip().isdigit())
    if days == list(range(7)) or not days:
        return "ежедневно"
    if days == [0, 1, 2, 3, 4]:
        return "по будням"
    if days == [5, 6]:
        return "по выходным"
    return ", ".join(WEEKDAY_NAMES[d] for d in days)


def describe_task(task: dict, title: str) -> str:
    arg = f" «{task['arg']}»" if task.get("arg") else ""
    state = "" if task["enabled"] else " (выкл.)"
    if task["kind"] == "once":
        when = datetime.fromtimestamp(task["run_at"]).strftime("%d.%m %H:%M")
        return f"#{task['id']} 🕐 {when} — {title}{arg}{state}"
    return f"#{task['id']} 🔁 {task['time_of_day']} {describe_weekdays(task['weekdays'])} — {title}{arg}{state}"


def is_due(task: dict, now: datetime) -> str | None:
    """'run' — пора выполнить, 'missed' — пропущена, None — ещё не время."""
    ts = now.timestamp()
    if task["kind"] == "once":
        if task["run_at"] is None or task["run_at"] > ts:
            return None
        return "run" if ts - task["run_at"] <= ONCE_GRACE else "missed"
    if task["kind"] == "daily":
        try:
            h, m = parse_time(task["time_of_day"])
        except ValueError:
            return None
        days = [int(x) for x in (task["weekdays"] or "").split(",") if x.strip().isdigit()] or list(range(7))
        target = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if now.weekday() not in days or not (target <= now < target + DAILY_GRACE):
            return None
        if task["last_run"] and task["last_run"] >= target.timestamp():
            return None
        return "run"
    return None


class Scheduler:
    def __init__(self, ctx: "AppContext"):
        self.ctx = ctx
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._ensure_default_tasks()
        self._thread = threading.Thread(target=self._loop, name="scheduler", daemon=True)
        self._thread.start()

    def _ensure_default_tasks(self) -> None:
        db = self.ctx.db
        if db.get_setting("default_tasks_created"):
            return
        t = (self.ctx.config["updates"].get("daily_check_time") or "").strip()
        if t:
            try:
                parse_time(t)
                db.add_task("check_updates", "", "daily", time_of_day=t, note="создано автоматически")
            except ValueError:
                log.warning("Неверное updates.daily_check_time: %s", t)
        db.set_setting("default_tasks_created", True)

    # --- создание задач (используется ботом и веб-панелью) ---
    def add_once(self, action: str, arg: str, run_at: float) -> int:
        self._validate(action)
        return self.ctx.db.add_task(action, arg, "once", run_at=run_at)

    def add_daily(self, action: str, arg: str, time_of_day: str, weekdays: list[int] | None = None) -> int:
        self._validate(action)
        h, m = parse_time(time_of_day)
        return self.ctx.db.add_task(action, arg, "daily", time_of_day=f"{h:02d}:{m:02d}",
                                    weekdays=weekdays_str(weekdays or list(range(7))))

    @staticmethod
    def next_time_of_day(h: int, m: int) -> float:
        now = datetime.now()
        target = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if target <= now:
            target += timedelta(days=1)
        return target.timestamp()

    def _validate(self, action: str) -> None:
        act = self.ctx.actions.get(action)
        if not act or act not in self.ctx.actions.available():
            raise ValueError(f"Неизвестное или недоступное действие: {action}")

    def describe(self, task: dict) -> str:
        act = self.ctx.actions.get(task["action"])
        return describe_task(task, act.title if act else task["action"])

    # --- цикл ---
    def _loop(self) -> None:
        while not self.ctx.stop_event.is_set():
            try:
                self.tick()
            except Exception:
                log.exception("Ошибка планировщика")
            self.ctx.stop_event.wait(15)

    def tick(self, now: datetime | None = None) -> None:
        now = now or datetime.now()
        for task in self.ctx.db.list_tasks(only_enabled=True):
            state = is_due(task, now)
            if state is None:
                continue
            self.ctx.db.mark_task_run(task["id"], now.timestamp())
            if task["kind"] == "once":
                self.ctx.db.set_task_enabled(task["id"], False)
            desc = html.escape(self.describe(task))
            if state == "missed":
                self.ctx.notifier.notify(f"⏭ Задача пропущена (ПК был выключен):\n{desc}",
                                         category="scheduler", level="warning")
                continue
            log.info("Выполняю задачу #%s %s", task["id"], task["action"])
            act = self.ctx.actions.get(task["action"])
            ok, result = self.ctx.actions.run(task["action"], task["arg"] or "", source="scheduler",
                                              user=f"task#{task['id']}")
            # Действия питания и отправляющие что-то в Telegram сами сообщают о себе
            if not (act and act.power) and task["action"] not in ("notify", "screenshot", "status_report", "webcam"):
                self.ctx.notifier.notify(
                    f"⏰ Задача выполнена: {desc}\n{'✅' if ok else '❌'} {html.escape(result[:1500])}",
                    category="scheduler", level="info" if ok else "warning",
                )
