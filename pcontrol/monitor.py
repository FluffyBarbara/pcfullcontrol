"""Фоновый мониторинг: метрики в базу и уведомления о важных событиях."""
from __future__ import annotations

import html
import logging
import threading
import time
from datetime import datetime
from typing import TYPE_CHECKING

import psutil

from .system import info

if TYPE_CHECKING:
    from .core import AppContext

log = logging.getLogger(__name__)
E = html.escape

POWER_TITLES = {
    "shutdown": "выключен по команде", "reboot": "перезагружен по команде",
    "sleep": "переведён в сон по команде", "hibernate": "переведён в гибернацию по команде",
}


class Monitor:
    def __init__(self, ctx: "AppContext"):
        self.ctx = ctx
        self.cfg = ctx.config["monitor"]
        self._last_alert: dict[str, float] = {}
        self._cpu_high = 0
        self._prev_users: set[str] | None = None
        self._prev_ips: set[str] | None = None
        self._prev_plugged: bool | None = None
        self._prev_watched: set[str] | None = None
        self._battery_alerted = False
        self._last_prune = 0.0
        self._last_ip_check = 0.0
        self._last_temp_poll = 0.0
        self._temp: float | None = None
        self.latest: dict = {}

    def start(self) -> None:
        psutil.cpu_percent(None)  # «прогрев» счётчика
        threading.Thread(target=self._startup_report, name="startup-report", daemon=True).start()
        threading.Thread(target=self._loop, name="monitor", daemon=True).start()

    # ---------------------------------------------------------------
    def _startup_report(self) -> None:
        db = self.ctx.db
        last_hb = db.get_setting("last_heartbeat")
        last_power = db.get_setting("last_power_action")
        boot = psutil.boot_time()
        db.set_setting("last_power_action", None)
        db.set_setting("last_heartbeat", time.time())
        if not self.cfg["notify_on_start"]:
            return
        fmt = "%d.%m.%Y %H:%M"
        lines = []
        if last_hb and boot > last_hb:
            lines.append("🟢 <b>Компьютер включён</b>")
            lines.append(f"Загрузка системы: {datetime.fromtimestamp(boot).strftime(fmt)}")
            reason = ""
            if last_power and last_power.get("ts", 0) >= last_hb - 120:
                reason = POWER_TITLES.get(last_power.get("action"), "")
            off_text = (f"Был не в сети: {datetime.fromtimestamp(last_hb).strftime(fmt)} → "
                        f"{datetime.fromtimestamp(boot).strftime(fmt)} "
                        f"({info.fmt_duration(boot - last_hb)})")
            lines.append(off_text)
            if reason:
                lines.append(f"Перед этим ПК был {reason}.")
        elif last_hb:
            lines.append("🔄 <b>Агент PC Control перезапущен</b>")
            lines.append(f"ПК работает {info.fmt_duration(time.time() - boot)}")
        else:
            lines.append("🎉 <b>PC Control запущен впервые</b>")
            lines.append("Отправьте /start, чтобы открыть меню.")
        ips = info.local_ips()
        if ips:
            lines.append(f"🌐 Локальный IP: {E(', '.join(ips))}")
        web = self.ctx.config["web"]
        if web["enabled"] and ips:
            lines.append(f"🖥 Веб-панель: http://{ips[0]}:{web['port']}")
        self.ctx.notifier.notify("\n".join(lines), category="startup")

    # ---------------------------------------------------------------
    def _loop(self) -> None:
        interval = max(5, int(self.cfg["interval_seconds"]))
        while not self.ctx.stop_event.wait(interval):
            try:
                self.check()
            except Exception:
                log.exception("Ошибка мониторинга")

    def _alert(self, key: str, text: str, level: str = "warning", cooldown: bool = True) -> None:
        now = time.time()
        cd = float(self.cfg["alert_cooldown_minutes"]) * 60
        if cooldown and now - self._last_alert.get(key, 0) < cd:
            return
        self._last_alert[key] = now
        self.ctx.notifier.notify(text, category="alert", level=level)

    def check(self) -> None:
        cfg = self.cfg
        now = time.time()
        cpu = psutil.cpu_percent(None)
        vm = psutil.virtual_memory()
        disks = info.disks()
        if now - self._last_temp_poll > 60:  # датчик температуры опрашиваем раз в минуту
            self._last_temp_poll = now
            self._temp = info.cpu_temperature()
        temp = self._temp
        net = psutil.net_io_counters()
        main_disk = max(disks, key=lambda d: d["total"])["percent"] if disks else 0
        self.ctx.db.add_metrics(cpu, vm.percent, main_disk, temp, net.bytes_sent, net.bytes_recv)
        self.ctx.db.set_setting("last_heartbeat", now)
        self.latest = {"cpu": cpu, "ram": vm.percent, "temp": temp, "ts": now}

        # CPU
        if cpu >= cfg["cpu_percent"]:
            self._cpu_high += 1
            if self._cpu_high >= cfg["cpu_checks"]:
                self._alert("cpu", f"🔥 <b>Высокая загрузка CPU: {cpu:.0f}%</b>\n{self._top_processes('cpu')}")
        else:
            self._cpu_high = 0
        # RAM
        if vm.percent >= cfg["ram_percent"]:
            self._alert("ram", f"🧠 <b>Мало памяти: занято {vm.percent:.0f}%</b> "
                               f"({info.fmt_bytes(vm.available)} свободно)\n{self._top_processes('mem')}")
        # Диски
        for d in disks:
            free_pct = 100 - d["percent"]
            if free_pct <= cfg["disk_free_percent"]:
                self._alert(f"disk:{d['mount']}",
                            f"💽 <b>Заканчивается место на {E(d['mount'])}</b>: свободно "
                            f"{info.fmt_bytes(d['free'])} ({free_pct:.0f}%)", cooldown=True)
        # Температура
        if temp is not None and temp >= cfg["temp_celsius"]:
            self._alert("temp", f"🌡 <b>Высокая температура CPU: {temp:.0f}°C</b>", level="critical")
        # Батарея
        bat = info.battery()
        if bat:
            if self._prev_plugged is not None and bat["plugged"] != self._prev_plugged and cfg["notify_power_source"]:
                self.ctx.notifier.notify(
                    "🔌 Зарядка подключена" if bat["plugged"] else f"🔋 Работа от батареи ({bat['percent']}%)",
                    category="power")
            self._prev_plugged = bat["plugged"]
            if not bat["plugged"] and bat["percent"] <= cfg["battery_low_percent"]:
                if not self._battery_alerted:
                    self._alert("battery", f"🪫 <b>Низкий заряд батареи: {bat['percent']}%</b>",
                                level="critical", cooldown=False)
                    self._battery_alerted = True
            else:
                self._battery_alerted = False
        # Вход пользователей
        if cfg["notify_on_login"]:
            try:
                users = {f"{u.name}@{u.terminal or u.host or 'console'}" for u in psutil.users()}
            except Exception:
                users = set()
            if self._prev_users is not None:
                for u in sorted(users - self._prev_users):
                    self.ctx.notifier.notify(f"👤 Вход в систему: <b>{E(u)}</b>", category="login",
                                             level="warning")
                for u in sorted(self._prev_users - users):
                    self.ctx.notifier.notify(f"👋 Выход из системы: {E(u)}", category="login")
            self._prev_users = users
        # Смена IP
        if cfg["notify_ip_change"] and now - self._last_ip_check > 120:
            self._last_ip_check = now
            ips = set(info.local_ips())
            if self._prev_ips is not None and ips != self._prev_ips:
                self.ctx.notifier.notify(
                    f"🌐 Сеть изменилась\nБыло: {E(', '.join(sorted(self._prev_ips)) or 'нет сети')}\n"
                    f"Стало: {E(', '.join(sorted(ips)) or 'нет сети')}", category="network")
            self._prev_ips = ips
        # Отслеживаемые процессы
        watch = {w.lower() for w in cfg.get("watch_processes") or []}
        if watch:
            running = set()
            for p in psutil.process_iter(["name"]):
                n = (p.info["name"] or "").lower()
                if n in watch or n.removesuffix(".exe") in watch:
                    running.add(n)
            if self._prev_watched is not None:
                for n in sorted(running - self._prev_watched):
                    self.ctx.notifier.notify(f"▶️ Запущен процесс: <b>{E(n)}</b>", category="process")
                for n in sorted(self._prev_watched - running):
                    self.ctx.notifier.notify(f"⏹ Закрыт процесс: <b>{E(n)}</b>", category="process")
            self._prev_watched = running
        # Очистка старых данных раз в час
        if now - self._last_prune > 3600:
            self._last_prune = now
            self.ctx.db.prune(int(cfg["metrics_retention_days"]))

    @staticmethod
    def _top_processes(sort: str) -> str:
        from .system.processes import list_processes
        try:
            top = list_processes(sort=sort, limit=3)
        except Exception:
            return ""
        return "Топ процессов:\n" + "\n".join(
            f"• {E(p['name'])} — CPU {p['cpu']}%, RAM {info.fmt_bytes(p['mem'])}" for p in top)
