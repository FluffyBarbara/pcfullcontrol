"""Минимальный клиент Telegram Bot API на requests (без сторонних фреймворков)."""
from __future__ import annotations

import html
import json
import logging
from typing import Any

import requests

log = logging.getLogger(__name__)

MAX_TEXT = 4096


class TelegramError(Exception):
    def __init__(self, description: str, code: int | None = None):
        super().__init__(description)
        self.code = code


class TelegramAPI:
    def __init__(self, token: str, proxy: str = ""):
        self.token = token
        self.base = f"https://api.telegram.org/bot{token}/"
        self.file_base = f"https://api.telegram.org/file/bot{token}/"
        self.session = requests.Session()
        if proxy:
            self.session.proxies = {"http": proxy, "https": proxy}

    def call(self, method: str, files: dict | None = None, http_timeout: float = 30, **params: Any) -> Any:
        data = {}
        for k, v in params.items():
            if v is None:
                continue
            data[k] = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v
        try:
            r = self.session.post(self.base + method, data=data, files=files, timeout=http_timeout)
        except requests.RequestException as e:
            # Не логируем URL целиком — в нём токен
            raise TelegramError(f"сетевая ошибка: {type(e).__name__}") from None
        try:
            payload = r.json()
        except ValueError:
            raise TelegramError(f"HTTP {r.status_code}", r.status_code)
        if not payload.get("ok"):
            raise TelegramError(payload.get("description", "ошибка"), payload.get("error_code"))
        return payload["result"]

    # ---------- основные методы ----------
    def get_me(self) -> dict:
        return self.call("getMe")

    def get_updates(self, offset: int | None, timeout: int = 25) -> list[dict]:
        return self.call(
            "getUpdates", offset=offset, timeout=timeout,
            allowed_updates=["message", "callback_query"], http_timeout=timeout + 15,
        )

    def send_message(self, chat_id: int, text: str, reply_markup: dict | None = None,
                     parse_mode: str | None = "HTML", silent: bool = False) -> dict:
        if len(text) > MAX_TEXT:
            text = text[: MAX_TEXT - 20] + "\n…(обрезано)"
        try:
            return self.call("sendMessage", chat_id=chat_id, text=text, parse_mode=parse_mode,
                             reply_markup=reply_markup, disable_notification=silent,
                             link_preview_options={"is_disabled": True})
        except TelegramError as e:
            if parse_mode and "parse" in str(e).lower():
                # Если HTML сломан — отправим простым текстом
                return self.call("sendMessage", chat_id=chat_id, text=text, reply_markup=reply_markup,
                                 disable_notification=silent)
            raise

    def edit_message_text(self, chat_id: int, message_id: int, text: str,
                          reply_markup: dict | None = None, parse_mode: str = "HTML") -> None:
        if len(text) > MAX_TEXT:
            text = text[: MAX_TEXT - 20] + "\n…(обрезано)"
        try:
            self.call("editMessageText", chat_id=chat_id, message_id=message_id, text=text,
                      parse_mode=parse_mode, reply_markup=reply_markup,
                      link_preview_options={"is_disabled": True})
        except TelegramError as e:
            if "not modified" not in str(e):
                raise

    def send_photo(self, chat_id: int, data: bytes, caption: str | None = None,
                   reply_markup: dict | None = None, silent: bool = False) -> dict:
        return self.call("sendPhoto", files={"photo": ("screenshot.jpg", data, "image/jpeg")},
                         chat_id=chat_id, caption=caption, parse_mode="HTML",
                         reply_markup=reply_markup, disable_notification=silent, http_timeout=120)

    def send_document(self, chat_id: int, data: bytes, filename: str, caption: str | None = None,
                      silent: bool = False) -> dict:
        return self.call("sendDocument", files={"document": (filename, data)}, chat_id=chat_id,
                         caption=caption, parse_mode="HTML", disable_notification=silent,
                         http_timeout=600)

    def answer_callback(self, callback_id: str, text: str | None = None, alert: bool = False) -> None:
        try:
            self.call("answerCallbackQuery", callback_query_id=callback_id, text=text, show_alert=alert)
        except TelegramError:
            pass

    def send_chat_action(self, chat_id: int, action: str = "typing") -> None:
        try:
            self.call("sendChatAction", chat_id=chat_id, action=action)
        except TelegramError:
            pass

    def set_commands(self, commands: list[tuple[str, str]]) -> None:
        self.call("setMyCommands", commands=[{"command": c, "description": d} for c, d in commands])

    def download_file(self, file_id: str) -> tuple[bytes, str]:
        info = self.call("getFile", file_id=file_id)
        path = info["file_path"]
        r = self.session.get(self.file_base + path, timeout=300)
        r.raise_for_status()
        return r.content, path

    # ---------- помощники ----------
    def send_long(self, chat_id: int, title: str, text: str, filename: str = "output.txt",
                  silent: bool = False) -> None:
        """Короткий текст — сообщением в <pre>, длинный — файлом."""
        text = text or "(нет вывода)"
        if len(text) <= 3500:
            self.send_message(chat_id, f"{title}\n<pre>{html.escape(text)}</pre>", silent=silent)
        else:
            self.send_document(chat_id, text.encode("utf-8"), filename, caption=title, silent=silent)


def inline_kb(rows: list[list[tuple[str, str]]]) -> dict:
    """[[("Текст", "callback_data"), ...], ...] -> inline_keyboard. URL, если data начинается с http."""
    return {"inline_keyboard": [
        [({"text": t, "url": d} if d.startswith("http") else {"text": t, "callback_data": d[:64]})
         for t, d in row]
        for row in rows
    ]}


def reply_kb(rows: list[list[str]]) -> dict:
    return {"keyboard": [[{"text": t} for t in row] for row in rows],
            "resize_keyboard": True, "is_persistent": True}
