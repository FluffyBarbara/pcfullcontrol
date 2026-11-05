"""Общий контекст приложения: конфиг, база, уведомления, действия, фоновые службы."""
from __future__ import annotations

import logging
import secrets
import socket
import threading
import time

from .actions import ActionRegistry
from .auth import WebAuth
from .config import Config
from .db import Database
from .jobs import JobManager
from .notifier import Notifier
from .system.files import FileManager
from .telegram_api import TelegramAPI

log = logging.getLogger(__name__)


class AppContext:
    def __init__(self, config: Config, db_path: str | None = None):
        self.config = config
        self.started_at = time.time()
        self.stop_event = threading.Event()
        self.db = Database(db_path or (config.data_dir / "pcontrol.db"))
        self.pc_name = config["pc_name"] or socket.gethostname()

        tg_cfg = config["telegram"]
        self.tg: TelegramAPI | None = None
        if tg_cfg["enabled"] and tg_cfg["token"]:
            self.tg = TelegramAPI(tg_cfg["token"], tg_cfg.get("proxy") or "")

        sec = config["security"]
        self.web_auth = WebAuth(self.db, int(config["web"]["session_days"]),
                                int(sec["max_login_attempts"]), int(sec["lockout_minutes"]))
        self.files = FileManager(config["files"]["allowed_roots"], config.upload_dir)
        self.notifier = Notifier(self)
        self.jobs = JobManager(self)
        self.actions = ActionRegistry(self)

        self.monitor = None
        self.scheduler = None
        self.bot = None

    # ---------- авторизация Telegram ----------
    def authorized_ids(self) -> list[int]:
        ids = list(self.config["telegram"]["allowed_user_ids"])
        ids += [u["user_id"] for u in self.db.list_tg_users()]
        return list(dict.fromkeys(ids))

    def is_authorized(self, user_id: int) -> bool:
        return user_id in self.authorized_ids()

    def pairing_code(self, regenerate: bool = False) -> str:
        code = self.db.get_setting("pair_code")
        if regenerate or not code:
            code = secrets.token_hex(4).upper()
            self.db.set_setting("pair_code", code)
        return code

    # ---------- запуск/остановка ----------
    def start_services(self, bot: bool = True) -> None:
        from .monitor import Monitor
        from .scheduler import Scheduler

        self.monitor = Monitor(self)
        self.monitor.start()
        self.scheduler = Scheduler(self)
        self.scheduler.start()
        if bot and self.tg:
            from .telegram_bot import TelegramBot
            self.bot = TelegramBot(self)
            self.bot.start()
        elif bot:
            log.warning("Telegram-бот выключен: не указан telegram.token в config.yaml")

    def shutdown_components(self) -> None:
        self.stop_event.set()
        try:
            self.notifier.flush(3)
        except Exception:
            pass
