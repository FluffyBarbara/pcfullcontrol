import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pcontrol.config import DEFAULTS, Config, deep_merge  # noqa: E402


class FakeTelegram:
    """Подменяет TelegramAPI: запоминает все отправленные сообщения."""

    def __init__(self):
        self.sent = []
        self.token = "test"

    def _rec(self, kind, chat_id, **kw):
        self.sent.append({"kind": kind, "chat_id": chat_id, **kw})
        return {"message_id": len(self.sent)}

    def send_message(self, chat_id, text, reply_markup=None, parse_mode="HTML", silent=False):
        return self._rec("message", chat_id, text=text, kb=reply_markup)

    def edit_message_text(self, chat_id, message_id, text, reply_markup=None, parse_mode="HTML"):
        return self._rec("edit", chat_id, text=text, kb=reply_markup)

    def send_photo(self, chat_id, data, caption=None, reply_markup=None, silent=False):
        return self._rec("photo", chat_id, text=caption)

    def send_document(self, chat_id, data, filename, caption=None, silent=False):
        return self._rec("document", chat_id, text=caption, filename=filename, data=data)

    def send_long(self, chat_id, title, text, filename="output.txt", silent=False):
        return self._rec("long", chat_id, text=title + "\n" + text)

    def answer_callback(self, callback_id, text=None, alert=False):
        return self._rec("callback", None, text=text)

    def send_chat_action(self, chat_id, action="typing"):
        pass

    def download_file(self, file_id):
        return b"hello from phone", "documents/file.txt"

    def texts(self):
        return [m.get("text") or "" for m in self.sent]


@pytest.fixture
def config(tmp_path):
    cfg = Config(deep_merge(DEFAULTS, {
        "data_dir": str(tmp_path / "data"),
        "telegram": {"token": "", "allowed_user_ids": [111]},
        "files": {"upload_dir": str(tmp_path / "uploads")},
        "apps": {"Тест": "echo"},
        "updates": {"daily_check_time": "12:00"},
    }))
    return cfg


@pytest.fixture
def ctx(config):
    from pcontrol.core import AppContext
    from pcontrol.scheduler import Scheduler

    c = AppContext(config)
    c.scheduler = Scheduler(c)
    yield c
    c.stop_event.set()
    c.db.close()


@pytest.fixture
def bot_ctx(ctx):
    from pcontrol.telegram_bot import TelegramBot

    fake = FakeTelegram()
    ctx.tg = fake
    bot = TelegramBot(ctx)
    ctx.bot = bot
    return ctx, bot, fake
