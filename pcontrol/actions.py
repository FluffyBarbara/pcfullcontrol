"""Единый реестр действий. Им пользуются Telegram-бот, веб-панель и планировщик."""
from __future__ import annotations

import html
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable

from .platform_utils import IS_WINDOWS
from .system import info, media, misc, power, processes, screen, updates

if TYPE_CHECKING:
    from .core import AppContext

log = logging.getLogger(__name__)

SOURCE_NAMES = {"telegram": "Telegram", "web": "веб-панель", "scheduler": "планировщик", "cli": "консоль"}


@dataclass
class Action:
    name: str
    title: str
    category: str
    func: Callable[[str], str]
    dangerous: bool = False          # требует подтверждения
    arg_hint: str = ""               # подсказка для параметра; пусто — без параметра
    arg_required: bool = False
    requires_shell: bool = False     # доступно только при security.allow_shell
    windows_only: bool = False
    power: bool = False              # действие выключает/перезагружает ПК
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name, "title": self.title, "category": self.category,
            "dangerous": self.dangerous, "arg_hint": self.arg_hint,
            "arg_required": self.arg_required,
        }


class ActionRegistry:
    def __init__(self, ctx: "AppContext"):
        self.ctx = ctx
        self.actions: dict[str, Action] = {}
        self._register()

    # ------------------------------------------------------------------
    def add(self, name: str, title: str, category: str, func: Callable[[str], str], **kw) -> None:
        self.actions[name] = Action(name, title, category, func, **kw)

    def _register(self) -> None:
        a = self.add
        # Питание
        a("shutdown", "Выключить ПК", "power", power.shutdown, dangerous=True, power=True,
          arg_hint="задержка, мин (необязательно)")
        a("reboot", "Перезагрузить", "power", power.reboot, dangerous=True, power=True,
          arg_hint="задержка, мин (необязательно)")
        a("cancel_shutdown", "Отменить выключение", "power", power.cancel_shutdown)
        a("sleep", "Спящий режим", "power", power.sleep, dangerous=True, power=True)
        a("hibernate", "Гибернация", "power", power.hibernate, dangerous=True, power=True)
        a("lock", "Заблокировать экран", "power", power.lock)
        a("logoff", "Выйти из системы", "power", power.logoff, dangerous=True)
        a("monitor_off", "Выключить монитор", "power", power.monitor_off)
        # Медиа
        a("volume_up", "Громче", "media", media.volume_up)
        a("volume_down", "Тише", "media", media.volume_down)
        a("mute", "Вкл/выкл звук", "media", media.mute)
        a("set_volume", "Установить громкость", "media", media.set_volume,
          arg_hint="0–100", arg_required=True)
        a("play_pause", "Пауза/воспроизведение", "media", media.play_pause)
        a("next_track", "Следующий трек", "media", media.next_track)
        a("prev_track", "Предыдущий трек", "media", media.prev_track)
        # Обновления (фоновые задания)
        a("check_updates", "Проверить обновления программ", "updates",
          self._job("check_updates", "Проверка обновлений программ", updates.check_updates))
        a("upgrade_all", "Обновить все программы", "updates",
          self._job("upgrade_all", "Обновление всех программ", updates.upgrade_all), dangerous=True)
        a("win_update_check", "Проверить Windows Update", "updates",
          self._job("win_update_check", "Проверка Windows Update", updates.windows_update_check),
          windows_only=True)
        a("win_update_install", "Установить Windows Update", "updates",
          self._job("win_update_install", "Установка обновлений Windows", updates.windows_update_install),
          dangerous=True, windows_only=True)
        a("self_update", "Обновить агент PC Control", "updates",
          self._job("self_update", "Обновление агента", updates.self_update), dangerous=True)
        # Система
        a("status_report", "Отчёт о состоянии в Telegram", "system", self._status_report)
        a("screenshot", "Скриншот в Telegram", "system", self._screenshot_to_tg)
        a("webcam", "Фото с веб-камеры в Telegram", "system", self._webcam_to_tg)
        a("kill", "Завершить процесс", "system", processes.kill, dangerous=True,
          arg_hint="PID или имя процесса", arg_required=True)
        a("empty_recycle_bin", "Очистить корзину", "system", misc.empty_recycle_bin, dangerous=True)
        a("restart_agent", "Перезапустить агент", "system", self._restart_agent, dangerous=True)
        # Разное
        a("open_url", "Открыть ссылку", "misc", misc.open_url, arg_hint="https://…", arg_required=True)
        a("launch", "Запустить программу", "misc", misc.launch, arg_hint="программа или путь",
          arg_required=True)
        a("message", "Сообщение на экран", "misc", misc.show_message, arg_hint="текст", arg_required=True)
        a("say", "Озвучить текст", "misc", misc.say, arg_hint="текст", arg_required=True)
        a("clipboard_get", "Получить буфер обмена", "misc", misc.clipboard_get)
        a("clipboard_set", "Записать в буфер обмена", "misc", misc.clipboard_set,
          arg_hint="текст", arg_required=True)
        a("notify", "Напоминание в Telegram", "misc", self._reminder, arg_hint="текст", arg_required=True)
        a("shell", "Выполнить команду", "misc", misc.shell, arg_hint="команда", arg_required=True,
          requires_shell=True, dangerous=True)

    # ------------------------------------------------------------------
    def available(self) -> list[Action]:
        result = []
        for act in self.actions.values():
            if act.windows_only and not IS_WINDOWS:
                continue
            if act.requires_shell and not self.ctx.config["security"]["allow_shell"]:
                continue
            result.append(act)
        return result

    def get(self, name: str) -> Action | None:
        return self.actions.get(name)

    def run(self, name: str, arg: str = "", source: str = "cli", user: str = "") -> tuple[bool, str]:
        act = self.actions.get(name)
        if not act:
            return False, f"Неизвестное действие: {name}"
        if act.requires_shell and not self.ctx.config["security"]["allow_shell"]:
            return False, "Выполнение команд отключено (security.allow_shell: false в config.yaml)"
        if act.windows_only and not IS_WINDOWS:
            return False, "Это действие доступно только в Windows"
        arg = (arg or "").strip()
        if act.arg_required and not arg:
            return False, f"Нужен параметр: {act.arg_hint}"

        if act.power:
            self.ctx.db.set_setting("last_power_action", {"action": name, "ts": time.time(), "source": source})
            src = SOURCE_NAMES.get(source, source)
            if source != "telegram":
                self.ctx.notifier.notify(f"⚡ <b>{html.escape(act.title)}</b> (источник: {src})",
                                         category="power", level="warning")
                self.ctx.notifier.flush(5)
        try:
            result = act.func(arg) or "Готово"
            ok = True
        except Exception as e:
            log.warning("Действие %s завершилось ошибкой: %s", name, e)
            result, ok = f"Ошибка: {e}", False
            if act.power:
                self.ctx.db.set_setting("last_power_action", None)

        self.ctx.db.log_command(source, user, name, arg, ok, result)
        if source == "web" and self.ctx.config["telegram"]["notify_web_actions"] and not act.power:
            arg_text = f": <code>{html.escape(arg[:200])}</code>" if arg else ""
            self.ctx.notifier.notify(
                f"🌐 Веб-панель: <b>{html.escape(act.title)}</b>{arg_text}\n{'✅' if ok else '❌'} "
                f"{html.escape(result[:500])}",
                category="web", log_event=False,
            )
        return ok, result

    # ---------- реализации, которым нужен контекст ----------
    def _job(self, kind: str, title: str, func: Callable[[], str]) -> Callable[[str], str]:
        def start(arg: str = "") -> str:
            job_id, new = self.ctx.jobs.start(kind, title, func)
            if not new:
                return f"«{title}» уже выполняется (задание #{job_id})."
            return f"🔄 {title}: запущено (задание #{job_id}). Результат придёт уведомлением."
        return start

    def _status_report(self, arg: str = "") -> str:
        text = info.format_status(info.get_status(), self.ctx.pc_name)
        self.ctx.notifier.notify("📊 Отчёт о состоянии\n" + text, category="report", log_event=False)
        return "Отчёт отправлен в Telegram"

    def _screenshot_to_tg(self, arg: str = "") -> str:
        img = screen.screenshot()
        self.ctx.notifier.notify("📸 Скриншот", category="screenshot", photo=img, log_event=False)
        return "Скриншот отправлен в Telegram"

    def _webcam_to_tg(self, arg: str = "") -> str:
        img = screen.webcam_photo()
        self.ctx.notifier.notify("📷 Фото с веб-камеры", category="webcam", photo=img, log_event=False)
        return "Фото отправлено в Telegram"

    def _reminder(self, arg: str) -> str:
        self.ctx.notifier.notify(f"⏰ {html.escape(arg)}", category="reminder", level="warning")
        return "Напоминание отправлено"

    def _restart_agent(self, arg: str = "") -> str:
        def do():
            self.ctx.shutdown_components()
            if IS_WINDOWS:
                import subprocess
                subprocess.Popen([sys.executable] + sys.argv, cwd=os.getcwd(), creationflags=0x00000008)
                os._exit(0)
            os.execv(sys.executable, [sys.executable] + sys.argv)
        threading.Timer(2, do).start()
        return "Агент перезапускается…"
