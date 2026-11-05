"""Уведомления в Telegram. Все уведомления также пишутся в локальный журнал событий."""
from __future__ import annotations

import html
import logging
import queue
import re
import threading
import time
from typing import TYPE_CHECKING

from .telegram_api import TelegramError

if TYPE_CHECKING:
    from .core import AppContext

log = logging.getLogger(__name__)
_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(text: str) -> str:
    return html.unescape(_TAG_RE.sub("", text))


class Notifier:
    def __init__(self, ctx: "AppContext"):
        self.ctx = ctx
        self._q: queue.Queue = queue.Queue()
        self._thread = threading.Thread(target=self._worker, name="notifier", daemon=True)
        self._thread.start()

    @property
    def muted(self) -> bool:
        return bool(self.ctx.db.get_setting("notifications_muted", False))

    def set_muted(self, muted: bool) -> None:
        self.ctx.db.set_setting("notifications_muted", muted)

    def notify(self, text: str, category: str = "info", level: str = "info",
               photo: bytes | None = None, document: tuple[str, bytes] | None = None,
               log_event: bool = True) -> None:
        """text — HTML. level: info | warning | critical. critical приходит даже при отключённых уведомлениях."""
        if log_event:
            try:
                self.ctx.db.add_event(level, category, strip_html(text)[:2000])
            except Exception:
                log.exception("Не удалось записать событие")
        log.info("[%s] %s", category, strip_html(text).replace("\n", " | ")[:300])
        if not self.ctx.tg:
            return
        if self.muted and level != "critical":
            return
        header = f"🖥 <b>{html.escape(self.ctx.pc_name)}</b>\n"
        self._q.put((header + text, photo, document, level == "info"))

    def flush(self, timeout: float = 10) -> None:
        """Подождать отправки очереди (например, перед выключением)."""
        deadline = time.time() + timeout
        while not self._q.empty() and time.time() < deadline:
            time.sleep(0.2)
        time.sleep(0.5)

    def _worker(self) -> None:
        while True:
            text, photo, document, silent = self._q.get()
            for chat_id in self.ctx.authorized_ids():
                for attempt in range(3):
                    try:
                        if photo:
                            self.ctx.tg.send_photo(chat_id, photo, caption=text[:1024], silent=silent)
                        elif document:
                            self.ctx.tg.send_document(chat_id, document[1], document[0],
                                                      caption=text[:1024], silent=silent)
                        else:
                            self.ctx.tg.send_message(chat_id, text, silent=silent)
                        break
                    except TelegramError as e:
                        if e.code in (400, 403):  # чат недоступен / бот заблокирован
                            log.warning("Telegram: не удалось отправить в %s: %s", chat_id, e)
                            break
                        time.sleep(2 * (attempt + 1))
                    except Exception:
                        log.exception("Ошибка отправки уведомления")
                        break
