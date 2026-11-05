"""Telegram-бот: управление ПК кнопками и командами."""
from __future__ import annotations

import html
import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import TYPE_CHECKING, Callable

from .platform_utils import IS_WINDOWS
from .scheduler import parse_duration, parse_time, parse_weekdays
from .system import info, processes, screen
from .system.files import TELEGRAM_FILE_LIMIT, FileAccessError
from .telegram_api import TelegramError, inline_kb, reply_kb

if TYPE_CHECKING:
    from .core import AppContext

log = logging.getLogger(__name__)
E = html.escape

MAIN_KB = reply_kb([
    ["📊 Статус", "📸 Скриншот"],
    ["⚡ Питание", "🔊 Медиа"],
    ["🧩 Процессы", "🔄 Обновления"],
    ["📁 Файлы", "⏰ Планировщик"],
    ["🛠 Ещё", "📜 Журнал"],
])

BOT_COMMANDS = [
    ("start", "Главное меню"), ("status", "Состояние ПК"), ("screen", "Скриншот"),
    ("power", "Питание"), ("shutdown", "Выключить [через N мин]"), ("reboot", "Перезагрузить"),
    ("sleep", "Спящий режим"), ("lock", "Заблокировать экран"), ("cancel", "Отменить выключение"),
    ("media", "Звук и медиа"), ("vol", "Громкость 0–100"), ("ps", "Процессы"),
    ("kill", "Завершить процесс"), ("updates", "Обновления ПО"), ("files", "Файлы"),
    ("get", "Скачать файл по пути"), ("tasks", "Планировщик"), ("at", "Задача на время"),
    ("in", "Задача через N минут"), ("daily", "Ежедневная задача"), ("msg", "Сообщение на экран"),
    ("say", "Озвучить текст"), ("open", "Открыть ссылку"), ("run", "Запустить программу"),
    ("clip", "Буфер обмена ПК"), ("cmd", "Выполнить команду"), ("ip", "IP-адреса"),
    ("webcam", "Фото с веб-камеры"), ("log", "Журнал событий"), ("notify", "Вкл/выкл уведомления"),
    ("web", "Веб-панель и пароль"), ("actions", "Список действий"), ("help", "Справка"),
    ("myid", "Мой Telegram ID"),
]

HELP = """<b>PC Control — управление компьютером</b>

Пользуйтесь кнопками внизу или командами:

<b>Питание:</b> /shutdown [мин], /reboot [мин], /sleep, /lock, /cancel
<b>Медиа:</b> /media, /vol 50
<b>Процессы:</b> /ps [имя], /kill &lt;PID или имя&gt;
<b>Файлы:</b> /files, /get &lt;путь&gt;; отправьте боту файл — он сохранится на ПК
<b>Обновления:</b> /updates
<b>Разное:</b> /msg текст, /say текст, /open ссылка, /run программа, /clip [текст], /ip, /webcam
<b>Терминал:</b> /cmd команда (если разрешено в config.yaml)

<b>Планировщик</b> (/tasks):
• <code>/at 23:30 shutdown</code> — разово в указанное время
• <code>/in 45m shutdown</code> — через 45 минут (форматы: 30, 2h, 1h30m)
• <code>/daily 08:00 будни notify Пора вставать!</code> — по расписанию
  (дни: будни, выходные, пн-пт, сб,вс; можно не указывать)
• /actions — названия действий для задач

<b>Прочее:</b> /log, /notify (вкл/выкл уведомления), /web (веб-панель), /myid"""

# Короткие русские синонимы для планировщика
ACTION_ALIASES = {
    "выключить": "shutdown", "выкл": "shutdown", "перезагрузить": "reboot", "перезагрузка": "reboot",
    "сон": "sleep", "гибернация": "hibernate", "блок": "lock", "заблокировать": "lock",
    "напомнить": "notify", "напоминание": "notify", "скриншот": "screenshot", "отчёт": "status_report",
    "отчет": "status_report", "обновления": "check_updates", "обновить": "upgrade_all",
    "сообщение": "message", "сказать": "say", "открыть": "open_url", "запустить": "launch",
}

OUTPUT_ACTIONS = {"clipboard_get", "shell"}
FB_PAGE = 16


class TelegramBot:
    def __init__(self, ctx: "AppContext"):
        self.ctx = ctx
        self.api = ctx.tg
        self.confirm = bool(ctx.config["telegram"]["confirm_dangerous"])
        self.offset: int | None = None
        self.pending: dict[int, str] = {}          # chat_id -> действие, ждущее текстового параметра
        self.fb: dict[int, dict] = {}              # состояние файлового браузера по чатам
        self._store: dict[str, tuple] = {}         # длинные данные для callback-кнопок
        self._pair_fails: dict[int, int] = {}
        self._unauth_seen: dict[int, float] = {}
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tg")
        self.username = ""

        self.routes: dict[str, Callable[[int, str, dict], None]] = {
            "/start": self.cmd_start, "/menu": self.cmd_start, "/help": self.cmd_help,
            "/status": self.cmd_status, "📊 Статус": self.cmd_status,
            "/screen": self.cmd_screenshot, "/screenshot": self.cmd_screenshot, "📸 Скриншот": self.cmd_screenshot,
            "/power": self.cmd_power, "⚡ Питание": self.cmd_power,
            "/media": self.cmd_media, "🔊 Медиа": self.cmd_media,
            "/ps": self.cmd_processes, "🧩 Процессы": self.cmd_processes,
            "/updates": self.cmd_updates, "🔄 Обновления": self.cmd_updates,
            "/files": self.cmd_files, "/ls": self.cmd_files, "📁 Файлы": self.cmd_files,
            "/tasks": self.cmd_tasks, "⏰ Планировщик": self.cmd_tasks,
            "/more": self.cmd_more, "🛠 Ещё": self.cmd_more,
            "/log": self.cmd_log, "📜 Журнал": self.cmd_log,
            "/get": self.cmd_get, "/ip": self.cmd_ip, "/webcam": self.cmd_webcam,
            "/at": self.cmd_at, "/in": self.cmd_in, "/daily": self.cmd_daily,
            "/deltask": self.cmd_deltask, "/actions": self.cmd_actions,
            "/notify": self.cmd_notify, "/web": self.cmd_web, "/webpass": self.cmd_web,
            "/clip": self.cmd_clip, "/users": self.cmd_users, "/unpair": self.cmd_unpair,
            "/vol": lambda c, a, m: self.run_action(c, m, "set_volume", a) if a else self.cmd_media(c, a, m),
        }
        simple = {
            "/shutdown": "shutdown", "/reboot": "reboot", "/sleep": "sleep", "/hibernate": "hibernate",
            "/lock": "lock", "/logoff": "logoff", "/cancel": "cancel_shutdown", "/monitoroff": "monitor_off",
            "/kill": "kill", "/msg": "message", "/say": "say", "/open": "open_url", "/run": "launch",
            "/cmd": "shell", "/mute": "mute",
        }
        for cmd, action in simple.items():
            self.routes[cmd] = (lambda act: lambda c, a, m: self.run_action(c, m, act, a))(action)

    # ================================================================
    # Цикл получения обновлений
    # ================================================================
    def start(self) -> None:
        threading.Thread(target=self._loop, name="telegram-bot", daemon=True).start()

    def _loop(self) -> None:
        while not self.ctx.stop_event.is_set():
            try:
                me = self.api.get_me()
                self.username = me.get("username", "")
                log.info("Telegram-бот @%s запущен", self.username)
                break
            except TelegramError as e:
                if e.code == 401:
                    log.error("Неверный токен Telegram-бота (telegram.token). Бот не запущен.")
                    return
                log.warning("Нет связи с Telegram (%s), повтор через 15 с", e)
                self.ctx.stop_event.wait(15)
        try:
            self.api.set_commands(BOT_COMMANDS)
        except TelegramError as e:
            log.warning("setMyCommands: %s", e)
        self._skip_old_updates()
        if not self.ctx.authorized_ids():
            log.warning("Нет привязанных пользователей. Отправьте боту @%s команду: /pair %s",
                        self.username, self.ctx.pairing_code())

        while not self.ctx.stop_event.is_set():
            try:
                updates = self.api.get_updates(self.offset, timeout=25)
            except TelegramError as e:
                if e.code == 409:
                    log.error("Бот уже запущен в другом месте (ошибка 409). Остановите второй экземпляр.")
                else:
                    log.debug("getUpdates: %s", e)
                self.ctx.stop_event.wait(5)
                continue
            for upd in updates:
                self.offset = upd["update_id"] + 1
                self.pool.submit(self._safe_handle, upd)

    def _skip_old_updates(self) -> None:
        """Команды, отправленные пока ПК был выключен, не выполняем (чтобы не выключить ПК сразу после включения)."""
        try:
            old = self.api.get_updates(-1, timeout=0)
            if old:
                self.offset = old[-1]["update_id"] + 1
                log.info("Пропущены старые сообщения боту (отправлены, пока агент не работал)")
        except TelegramError:
            pass

    def _safe_handle(self, upd: dict) -> None:
        chat_id = None
        try:
            if "callback_query" in upd:
                chat_id = upd["callback_query"]["message"]["chat"]["id"]
                self.on_callback(upd["callback_query"])
            elif "message" in upd:
                chat_id = upd["message"]["chat"]["id"]
                self.on_message(upd["message"])
        except Exception as e:
            log.exception("Ошибка обработки сообщения Telegram")
            if chat_id:
                try:
                    self.api.send_message(chat_id, f"❌ Ошибка: {E(str(e))}")
                except TelegramError:
                    pass

    # ================================================================
    # Вспомогательное
    # ================================================================
    def send(self, chat_id: int, text: str, kb: dict | None = None) -> dict:
        return self.api.send_message(chat_id, text, reply_markup=kb)

    def edit_or_send(self, chat_id: int, message_id: int | None, text: str, kb: dict | None = None) -> None:
        if message_id:
            try:
                self.api.edit_message_text(chat_id, message_id, text, reply_markup=kb)
                return
            except TelegramError:
                pass
        self.send(chat_id, text, kb)

    def _put(self, *payload) -> str:
        """Сохранить данные для кнопки (лимит callback_data — 64 байта)."""
        if len(self._store) > 2000:
            self._store.clear()
        key = secrets.token_hex(4)
        self._store[key] = payload
        return key

    @staticmethod
    def _user_name(user: dict) -> str:
        return "@" + user["username"] if user.get("username") else str(user.get("id", ""))

    # ================================================================
    # Сообщения
    # ================================================================
    def on_message(self, msg: dict) -> None:
        chat = msg.get("chat") or {}
        if chat.get("type") != "private":
            return
        chat_id = chat["id"]
        user = msg.get("from") or {}
        uid = user.get("id")
        text = (msg.get("text") or "").strip()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.split("@")[0].lower() if cmd.startswith("/") else cmd
        arg = arg.strip()

        if cmd == "/myid":
            self.send(chat_id, f"Ваш Telegram ID: <code>{uid}</code>")
            return
        if cmd == "/pair":
            self.cmd_pair(chat_id, arg, user)
            return
        if not self.ctx.is_authorized(uid):
            self.unauthorized(chat_id, user)
            return

        if "document" in msg or "photo" in msg or "video" in msg or "audio" in msg:
            self.on_upload(chat_id, msg)
            return
        if not text:
            return

        handler = self.routes.get(cmd) or self.routes.get(text)
        if chat_id in self.pending and not handler:
            action = self.pending.pop(chat_id)
            self.run_action(chat_id, msg, action, text)
            return
        self.pending.pop(chat_id, None)
        if handler:
            handler(chat_id, arg, msg)
        else:
            self.send(chat_id, "Не понял команду 🤔 Нажмите /help или используйте кнопки меню.", MAIN_KB)

    def unauthorized(self, chat_id: int, user: dict) -> None:
        uid = user.get("id")
        self.send(chat_id, f"⛔ Нет доступа.\nВаш ID: <code>{uid}</code>\n"
                           "Владелец ПК может добавить его в config.yaml или привязать бота командой /pair &lt;код&gt;.")
        if time.time() - self._unauth_seen.get(uid, 0) > 3600:
            self._unauth_seen[uid] = time.time()
            self.ctx.notifier.notify(
                f"⚠️ Попытка доступа к боту: {E(self._user_name(user))} "
                f"({E(user.get('first_name', ''))}), ID <code>{uid}</code>",
                category="security", level="warning")

    def cmd_pair(self, chat_id: int, arg: str, user: dict) -> None:
        uid = user.get("id")
        if self.ctx.is_authorized(uid):
            self.send(chat_id, "✅ Вы уже привязаны.", MAIN_KB)
            return
        if self._pair_fails.get(uid, 0) >= 5:
            self.send(chat_id, "⛔ Слишком много неверных попыток.")
            return
        if arg and secrets.compare_digest(arg.strip().upper(), self.ctx.pairing_code()):
            self.ctx.db.add_tg_user(uid, user.get("username", ""))
            self.ctx.pairing_code(regenerate=True)
            self.ctx.notifier.notify(f"🔗 Привязан новый пользователь: {E(self._user_name(user))}",
                                     category="security", level="warning")
            self.send(chat_id, "✅ Бот привязан! Теперь вы можете управлять компьютером.\n\n" + HELP, MAIN_KB)
        else:
            self._pair_fails[uid] = self._pair_fails.get(uid, 0) + 1
            self.send(chat_id, "❌ Неверный код. Код показан в консоли/логе агента и в веб-панели (Настройки).")

    # ================================================================
    # Выполнение действий
    # ================================================================
    def run_action(self, chat_id: int, msg: dict | None, name: str, arg: str = "",
                   confirmed: bool = False, message_id: int | None = None,
                   user: dict | None = None, callback_id: str | None = None) -> None:
        act = self.ctx.actions.get(name)
        user = user or (msg or {}).get("from") or {}
        if not act or act not in self.ctx.actions.available():
            text = "❌ Действие недоступно"
            if act and act.requires_shell:
                text = "❌ Выполнение команд отключено. Включите security.allow_shell в config.yaml."
            self._reply(chat_id, text, callback_id)
            return
        if act.arg_required and not arg:
            self.pending[chat_id] = name
            self._reply(chat_id, None, callback_id)
            self.send(chat_id, f"✏️ <b>{E(act.title)}</b>\nВведите {E(act.arg_hint)}:",
                      inline_kb([[("✖️ Отмена", "x")]]))
            return
        if act.dangerous and self.confirm and not confirmed:
            key = self._put(name, arg)
            arg_text = f" <code>{E(arg)}</code>" if arg else ""
            self._reply(chat_id, None, callback_id)
            self.send(chat_id, f"⚠️ Подтвердите: <b>{E(act.title)}</b>{arg_text}?",
                      inline_kb([[("✅ Да", f"y|{key}"), ("❌ Отмена", "n")]]))
            return

        if name in OUTPUT_ACTIONS:
            self.api.send_chat_action(chat_id)
        ok, result = self.ctx.actions.run(name, arg, source="telegram", user=self._user_name(user))
        if name in OUTPUT_ACTIONS and ok:
            self._reply(chat_id, None, callback_id)
            self.api.send_long(chat_id, f"📋 <b>{E(act.title)}</b>", result)
            return
        text = f"{'✅' if ok else '❌'} {E(result)}"
        if message_id:
            self.edit_or_send(chat_id, message_id, text)
        elif callback_id and ok and len(result) < 180 and not act.dangerous:
            self.api.answer_callback(callback_id, result)  # короткий результат — всплывающей подсказкой
        else:
            self._reply(chat_id, text, callback_id)

    def _reply(self, chat_id: int, text: str | None, callback_id: str | None) -> None:
        if callback_id:
            self.api.answer_callback(callback_id)
        if text:
            self.send(chat_id, text)

    # ================================================================
    # Команды и меню
    # ================================================================
    def cmd_start(self, chat_id: int, arg: str, msg: dict) -> None:
        name = (msg.get("from") or {}).get("first_name", "")
        self.send(chat_id, f"👋 Привет{', ' + E(name) if name else ''}! Компьютер <b>{E(self.ctx.pc_name)}</b> "
                           "на связи.\nВыберите действие в меню ниже или нажмите /help.", MAIN_KB)

    def cmd_help(self, chat_id: int, arg: str, msg: dict) -> None:
        self.send(chat_id, HELP, MAIN_KB)

    def cmd_status(self, chat_id: int, arg: str, msg: dict, message_id: int | None = None) -> None:
        self.api.send_chat_action(chat_id)
        text = info.format_status(info.get_status(), self.ctx.pc_name)
        kb = inline_kb([[("🔄 Обновить", "st"), ("📸 Скриншот", "ss"), ("🧩 Процессы", "ps|cpu")]])
        self.edit_or_send(chat_id, message_id, text, kb)

    def cmd_screenshot(self, chat_id: int, arg: str, msg: dict) -> None:
        self.api.send_chat_action(chat_id, "upload_photo")
        try:
            mon = int(arg) if arg.isdigit() else 0
            img = screen.screenshot(monitor=mon)
        except Exception as e:
            self.send(chat_id, f"❌ {E(str(e))}")
            return
        rows = [[("🔄 Ещё раз", "ss"), ("📄 Файлом (без сжатия)", "ssd")]]
        n = screen.monitor_count()
        if n > 1:
            rows.append([(f"🖥 {i}", f"ss|{i}") for i in range(1, min(n, 4) + 1)])
        self.api.send_photo(chat_id, img, caption=f"📸 {datetime.now():%d.%m.%Y %H:%M:%S}",
                            reply_markup=inline_kb(rows))

    def cmd_power(self, chat_id: int, arg: str, msg: dict, message_id: int | None = None) -> None:
        kb = inline_kb([
            [("⏻ Выключить", "a|shutdown"), ("🔄 Перезагрузить", "a|reboot")],
            [("😴 Сон", "a|sleep"), ("❄️ Гибернация", "a|hibernate")],
            [("🔒 Заблокировать", "a|lock"), ("🚪 Выйти из системы", "a|logoff")],
            [("🌑 Выключить монитор", "a|monitor_off"), ("🚫 Отмена выключения", "a|cancel_shutdown")],
            [("⏻ через 30 мин", "a|shutdown|30"), ("⏻ через 1 ч", "a|shutdown|60"),
             ("⏻ через 2 ч", "a|shutdown|120")],
        ])
        self.edit_or_send(chat_id, message_id, "⚡ <b>Питание</b>", kb)

    def cmd_media(self, chat_id: int, arg: str, msg: dict, message_id: int | None = None) -> None:
        from .system.media import get_volume
        vol = get_volume()
        kb = inline_kb([
            [("🔉 Тише", "a|volume_down"), ("🔇", "a|mute"), ("🔊 Громче", "a|volume_up")],
            [("⏮", "a|prev_track"), ("⏯", "a|play_pause"), ("⏭", "a|next_track")],
            [(f"{v}%", f"a|set_volume|{v}") for v in (0, 25, 50, 75, 100)],
        ])
        vol_text = f"\nТекущая громкость: <b>{vol}%</b>" if vol is not None else ""
        self.edit_or_send(chat_id, message_id, f"🔊 <b>Звук и медиа</b>{vol_text}", kb)

    def cmd_processes(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None) -> None:
        sort, query = ("mem", "") if arg == "mem" else ("cpu", "" if arg in ("", "cpu") else arg)
        self.api.send_chat_action(chat_id)
        procs = processes.list_processes(sort=sort, limit=20, query=query)
        title = f"🧩 <b>Процессы</b> (сортировка: {'память' if sort == 'mem' else 'CPU'})"
        if query:
            title += f", поиск: «{E(query)}»"
        lines = [title, ""]
        for p in procs:
            lines.append(f"<code>{p['pid']:>6}</code> {E(p['name'][:28])} — "
                         f"{p['cpu']}% · {info.fmt_bytes(p['mem'])}")
        if not procs:
            lines.append("Ничего не найдено")
        lines.append("\nЗавершить: /kill &lt;PID или имя&gt;")
        rows = [[("По CPU", "ps|cpu"), ("По памяти", "ps|mem"), ("🔄", f"ps|{sort}")]]
        kill_btns = [(f"✖ {p['name'][:18]}", f"k|{p['pid']}") for p in procs[:8]]
        rows += [kill_btns[i:i + 2] for i in range(0, len(kill_btns), 2)]
        self.edit_or_send(chat_id, message_id, "\n".join(lines), inline_kb(rows))

    def cmd_updates(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None) -> None:
        rows = [
            [("🔍 Проверить обновления программ", "a|check_updates")],
            [("⬆️ Обновить все программы", "a|upgrade_all")],
        ]
        if IS_WINDOWS:
            rows += [[("🪟 Проверить Windows Update", "a|win_update_check")],
                     [("🪟 Установить обновления Windows", "a|win_update_install")]]
        rows += [[("🤖 Обновить агент PC Control", "a|self_update")],
                 [("📋 Последние задания", "jl")]]
        from .system.updates import available_managers
        mgrs = ", ".join(available_managers()) or "не найдены"
        self.edit_or_send(chat_id, message_id,
                          f"🔄 <b>Обновление ПО</b>\nМенеджеры пакетов: {E(mgrs)}\n"
                          "Долгие операции выполняются в фоне — результат придёт сообщением.",
                          inline_kb(rows))

    def cmd_more(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None) -> None:
        muted = self.ctx.notifier.muted
        rows = [
            [("💬 Сообщение на экран", "in|message"), ("🗣 Озвучить", "in|say")],
            [("🌐 Открыть ссылку", "in|open_url"), ("🚀 Запустить", "in|launch")],
            [("📋 Буфер ПК", "a|clipboard_get"), ("✏️ Текст в буфер", "in|clipboard_set")],
            [("📷 Веб-камера", "cam"), ("🌍 IP-адреса", "ip")],
        ]
        if self.ctx.config["apps"]:
            rows.append([("⭐ Мои программы", "apps")])
        if self.ctx.config["security"]["allow_shell"]:
            rows.append([("💻 Выполнить команду", "in|shell")])
        rows += [
            [("🗑 Очистить корзину", "a|empty_recycle_bin"), ("♻️ Перезапуск агента", "a|restart_agent")],
            [("🔔 Включить уведомления" if muted else "🔕 Выключить уведомления", "nt"),
             ("🖥 Веб-панель", "wp")],
        ]
        self.edit_or_send(chat_id, message_id, "🛠 <b>Дополнительно</b>", inline_kb(rows))

    def cmd_apps(self, chat_id: int, message_id: int | None = None) -> None:
        apps = list(self.ctx.config["apps"].items())
        btns = [(f"🚀 {name}", f"app|{i}") for i, (name, _) in enumerate(apps[:30])]
        rows = [btns[i:i + 2] for i in range(0, len(btns), 2)] + [[("⬅️ Назад", "more")]]
        self.edit_or_send(chat_id, message_id, "⭐ <b>Мои программы</b> (настраиваются в config.yaml → apps)",
                          inline_kb(rows))

    def cmd_ip(self, chat_id: int, arg: str, msg: dict | None) -> None:
        local = info.local_ips()
        pub = info.public_ip()
        web = self.ctx.config["web"]
        text = (f"🌍 <b>IP-адреса</b>\nЛокальные: {E(', '.join(local) or '—')}\n"
                f"Внешний: {E(pub or 'не удалось определить')}")
        if web["enabled"] and local:
            text += f"\nВеб-панель: http://{local[0]}:{web['port']}"
        self.send(chat_id, text)

    def cmd_webcam(self, chat_id: int, arg: str, msg: dict | None) -> None:
        self.api.send_chat_action(chat_id, "upload_photo")
        try:
            img = screen.webcam_photo()
        except Exception as e:
            self.send(chat_id, f"❌ {E(str(e))}")
            return
        self.ctx.db.log_command("telegram", "", "webcam", "", True, "фото отправлено")
        self.api.send_photo(chat_id, img, caption="📷 Веб-камера")

    def cmd_clip(self, chat_id: int, arg: str, msg: dict) -> None:
        if arg:
            self.run_action(chat_id, msg, "clipboard_set", arg)
        else:
            self.run_action(chat_id, msg, "clipboard_get")

    def cmd_notify(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None) -> None:
        muted = not self.ctx.notifier.muted
        self.ctx.notifier.set_muted(muted)
        self.send(chat_id, "🔕 Уведомления выключены (кроме критических)." if muted
                  else "🔔 Уведомления включены.")

    def cmd_web(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None) -> None:
        web = self.ctx.config["web"]
        if not web["enabled"]:
            self.send(chat_id, "Веб-панель выключена в config.yaml (web.enabled).")
            return
        ips = info.local_ips()
        urls = "\n".join(f"http://{ip}:{web['port']}" for ip in ips) or f"http://localhost:{web['port']}"
        self.edit_or_send(chat_id, message_id,
                          f"🖥 <b>Веб-панель</b>\n{E(urls)}\n\nОткройте адрес на телефоне в той же Wi-Fi сети "
                          "(или через VPN, например Tailscale).",
                          inline_kb([[("🔑 Сгенерировать новый пароль", "wpr")],
                                     [("🚪 Завершить все сеансы веб-панели", "wpl")]]))

    def cmd_log(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None,
                mode: str = "events") -> None:
        icons = {"info": "ℹ️", "warning": "⚠️", "critical": "🚨"}
        if mode == "commands":
            rows = self.ctx.db.recent_commands(20)
            lines = ["📜 <b>Последние команды</b>"]
            for r in rows:
                t = datetime.fromtimestamp(r["ts"]).strftime("%d.%m %H:%M")
                a = f" «{E(r['arg'][:30])}»" if r["arg"] else ""
                lines.append(f"{'✅' if r['ok'] else '❌'} {t} [{E(r['source'])}] {E(r['action'])}{a}")
        else:
            rows = self.ctx.db.recent_events(20)
            lines = ["📜 <b>Последние события</b>"]
            for r in rows:
                t = datetime.fromtimestamp(r["ts"]).strftime("%d.%m %H:%M")
                lines.append(f"{icons.get(r['level'], '•')} {t} {E(r['message'][:120])}")
        if len(lines) == 1:
            lines.append("пока пусто")
        kb = inline_kb([[("События", "log|events"), ("Команды", "log|commands"), ("Задания", "jl")]])
        self.edit_or_send(chat_id, message_id, "\n".join(lines), kb)

    def cmd_jobs(self, chat_id: int, message_id: int | None = None) -> None:
        jobs = self.ctx.db.recent_jobs(10)
        icons = {"running": "⏳", "done": "✅", "error": "❌"}
        lines = ["📋 <b>Фоновые задания</b>"]
        btns = []
        for j in jobs:
            t = datetime.fromtimestamp(j["started"]).strftime("%d.%m %H:%M")
            lines.append(f"{icons.get(j['status'], '•')} #{j['id']} {t} — {E(j['title'])}")
            if j["status"] != "running":
                btns.append((f"#{j['id']}", f"j|{j['id']}"))
        if not jobs:
            lines.append("заданий ещё не было")
        rows = [btns[i:i + 5] for i in range(0, len(btns), 5)] + [[("🔄 Обновить", "jl")]]
        self.edit_or_send(chat_id, message_id, "\n".join(lines), inline_kb(rows))

    def cmd_actions(self, chat_id: int, arg: str, msg: dict | None) -> None:
        lines = ["🧰 <b>Действия для планировщика</b>"]
        for act in self.ctx.actions.available():
            hint = f" &lt;{E(act.arg_hint)}&gt;" if act.arg_hint else ""
            lines.append(f"<code>{act.name}</code>{hint} — {E(act.title)}")
        lines.append("\nПример: <code>/at 23:00 shutdown</code>")
        self.send(chat_id, "\n".join(lines))

    def cmd_users(self, chat_id: int, arg: str, msg: dict | None) -> None:
        lines = ["👥 <b>Пользователи бота</b>"]
        for uid in self.ctx.config["telegram"]["allowed_user_ids"]:
            lines.append(f"• <code>{uid}</code> (config.yaml)")
        for u in self.ctx.db.list_tg_users():
            lines.append(f"• <code>{u['user_id']}</code> @{E(u['username'] or '—')} (привязан, /unpair {u['user_id']})")
        self.send(chat_id, "\n".join(lines))

    def cmd_unpair(self, chat_id: int, arg: str, msg: dict | None) -> None:
        if arg.isdigit() and self.ctx.db.remove_tg_user(int(arg)):
            self.send(chat_id, f"Пользователь {arg} отвязан.")
        else:
            self.send(chat_id, "Укажите ID привязанного пользователя: /unpair 123456")

    # ================================================================
    # Планировщик
    # ================================================================
    def cmd_tasks(self, chat_id: int, arg: str, msg: dict | None, message_id: int | None = None) -> None:
        tasks = self.ctx.db.list_tasks()
        lines = ["⏰ <b>Планировщик</b>"]
        rows = []
        for t in tasks:
            lines.append(E(self.ctx.scheduler.describe(t)))
            rows.append([(("⏸ " if t["enabled"] else "▶️ ") + f"#{t['id']}", f"tt|{t['id']}"),
                         (f"🗑 #{t['id']}", f"td|{t['id']}")])
        if not tasks:
            lines.append("Задач нет.")
        lines.append("\nДобавить:\n<code>/at 23:30 shutdown</code>\n<code>/in 1h reboot</code>\n"
                     "<code>/daily 09:00 будни notify Работаем!</code>")
        rows.append([("🧰 Список действий", "acts"), ("🔄 Обновить", "tl")])
        self.edit_or_send(chat_id, message_id, "\n".join(lines), inline_kb(rows))

    def _parse_action(self, tokens: list[str]) -> tuple[str, str]:
        if not tokens:
            raise ValueError("Укажите действие, например shutdown. Список: /actions")
        name = ACTION_ALIASES.get(tokens[0].lower(), tokens[0].lower())
        act = self.ctx.actions.get(name)
        if not act or act not in self.ctx.actions.available():
            raise ValueError(f"Неизвестное действие «{tokens[0]}». Список: /actions")
        arg = " ".join(tokens[1:])
        if act.arg_required and not arg:
            raise ValueError(f"Для «{act.title}» нужен параметр: {act.arg_hint}")
        return name, arg

    def cmd_at(self, chat_id: int, arg: str, msg: dict | None) -> None:
        tokens = arg.split()
        try:
            if not tokens:
                raise ValueError("Пример: /at 23:30 shutdown")
            h, m = parse_time(tokens[0])
            name, a = self._parse_action(tokens[1:])
            run_at = self.ctx.scheduler.next_time_of_day(h, m)
            tid = self.ctx.scheduler.add_once(name, a, run_at)
        except ValueError as e:
            self.send(chat_id, f"❌ {E(str(e))}")
            return
        self.send(chat_id, f"✅ Задача добавлена:\n{E(self.ctx.scheduler.describe(self.ctx.db.get_task(tid)))}")

    def cmd_in(self, chat_id: int, arg: str, msg: dict | None) -> None:
        tokens = arg.split()
        try:
            if not tokens:
                raise ValueError("Пример: /in 30m shutdown")
            secs = parse_duration(tokens[0])
            name, a = self._parse_action(tokens[1:])
            tid = self.ctx.scheduler.add_once(name, a, time.time() + secs)
        except ValueError as e:
            self.send(chat_id, f"❌ {E(str(e))}")
            return
        self.send(chat_id, f"✅ Задача добавлена:\n{E(self.ctx.scheduler.describe(self.ctx.db.get_task(tid)))}")

    def cmd_daily(self, chat_id: int, arg: str, msg: dict | None) -> None:
        tokens = arg.split()
        try:
            if not tokens:
                raise ValueError("Пример: /daily 23:00 shutdown или /daily 08:00 будни notify Подъём")
            parse_time(tokens[0])
            days = parse_weekdays(tokens[1]) if len(tokens) > 1 else None
            rest = tokens[2:] if days else tokens[1:]
            name, a = self._parse_action(rest)
            tid = self.ctx.scheduler.add_daily(name, a, tokens[0], days)
        except ValueError as e:
            self.send(chat_id, f"❌ {E(str(e))}")
            return
        self.send(chat_id, f"✅ Задача добавлена:\n{E(self.ctx.scheduler.describe(self.ctx.db.get_task(tid)))}")

    def cmd_deltask(self, chat_id: int, arg: str, msg: dict | None) -> None:
        if arg.lstrip("#").isdigit() and self.ctx.db.delete_task(int(arg.lstrip("#"))):
            self.send(chat_id, f"🗑 Задача #{arg.lstrip('#')} удалена.")
        else:
            self.send(chat_id, "Укажите номер задачи: /deltask 3")

    # ================================================================
    # Файлы
    # ================================================================
    def cmd_files(self, chat_id: int, arg: str, msg: dict | None) -> None:
        self.fb_show(chat_id, arg or None)

    def fb_show(self, chat_id: int, path: str | None, page: int = 0, message_id: int | None = None) -> None:
        fm = self.ctx.files
        try:
            entries = fm.list_dir(path) if path else fm.roots()
        except FileAccessError as e:
            self.edit_or_send(chat_id, message_id, f"❌ {E(str(e))}")
            return
        self.fb[chat_id] = {"path": path, "entries": entries}
        pages = max(1, (len(entries) + FB_PAGE - 1) // FB_PAGE)
        page = max(0, min(page, pages - 1))
        chunk = entries[page * FB_PAGE:(page + 1) * FB_PAGE]
        rows = []
        for i, e in enumerate(chunk, start=page * FB_PAGE):
            label = f"📁 {e['name']}" if e["is_dir"] else f"📄 {e['name']} · {info.fmt_bytes(e['size'])}"
            rows.append([(label[:60], f"f|{i}")])
        nav = []
        if path:
            parent = fm.parent(path)
            nav.append(("⬆️ Вверх", "fu" if parent else "fr"))
            nav.append(("💽 Диски", "fr"))
        if page > 0:
            nav.append(("◀️", f"fp|{page - 1}"))
        if page < pages - 1:
            nav.append(("▶️", f"fp|{page + 1}"))
        if nav:
            rows.append(nav)
        dirs = sum(1 for e in entries if e["is_dir"])
        title = f"📁 <code>{E(path)}</code>" if path else "📁 <b>Файлы</b> — выберите расположение"
        text = (f"{title}\nПапок: {dirs}, файлов: {len(entries) - dirs}"
                + (f" · стр. {page + 1}/{pages}" if pages > 1 else "")
                + "\n\nНажмите на файл, чтобы скачать. Отправьте файл в чат — он сохранится на ПК.")
        self.edit_or_send(chat_id, message_id, text, inline_kb(rows) if rows else None)

    def fb_open(self, chat_id: int, idx: int, message_id: int) -> None:
        st = self.fb.get(chat_id)
        if not st or idx >= len(st["entries"]):
            self.fb_show(chat_id, None, message_id=message_id)
            return
        entry = st["entries"][idx]
        if entry["is_dir"]:
            self.fb_show(chat_id, entry["path"], message_id=message_id)
        else:
            self.send_file(chat_id, entry["path"])

    def cmd_get(self, chat_id: int, arg: str, msg: dict | None) -> None:
        if not arg:
            self.send(chat_id, "Укажите путь: /get C:\\Users\\me\\file.txt")
            return
        self.send_file(chat_id, arg.strip('"'))

    def send_file(self, chat_id: int, path: str) -> None:
        try:
            p = self.ctx.files.file_for_download(path)
            size = p.stat().st_size
            if size > TELEGRAM_FILE_LIMIT:
                self.send(chat_id, f"❌ Файл слишком большой для Telegram ({info.fmt_bytes(size)} > 50 МБ). "
                                   "Скачайте его через веб-панель.")
                return
            self.api.send_chat_action(chat_id, "upload_document")
            self.api.send_document(chat_id, p.read_bytes(), p.name, caption=f"📄 <code>{E(str(p))}</code>")
            self.ctx.db.log_command("telegram", "", "download", str(p), True, info.fmt_bytes(size))
        except (FileAccessError, OSError) as e:
            self.send(chat_id, f"❌ {E(str(e))}")

    def on_upload(self, chat_id: int, msg: dict) -> None:
        if "document" in msg:
            f = msg["document"]
            name = f.get("file_name") or "file"
        elif "photo" in msg:
            f = msg["photo"][-1]
            name = f"photo_{datetime.now():%Y%m%d_%H%M%S}.jpg"
        else:
            f = msg.get("video") or msg.get("audio")
            name = f.get("file_name") or f"media_{datetime.now():%Y%m%d_%H%M%S}"
        if f.get("file_size", 0) > 20 * 1024 * 1024:
            self.send(chat_id, "❌ Бот может получить файл до 20 МБ (ограничение Telegram). "
                               "Для больших файлов используйте веб-панель.")
            return
        st = self.fb.get(chat_id) or {}
        target_dir = st.get("path") if (msg.get("caption") or "").strip() == "сюда" else None
        try:
            data, _ = self.api.download_file(f["file_id"])
            saved = self.ctx.files.save_upload(name, data, target_dir)
        except (TelegramError, FileAccessError, OSError) as e:
            self.send(chat_id, f"❌ Не удалось сохранить файл: {E(str(e))}")
            return
        self.ctx.db.log_command("telegram", "", "upload", str(saved), True, info.fmt_bytes(len(data)))
        self.send(chat_id, f"✅ Сохранено на ПК:\n<code>{E(str(saved))}</code>\n"
                           "<i>Подсказка: подпись «сюда» сохранит файл в папку, открытую в /files.</i>",
                  inline_kb([[("🚀 Открыть на ПК", f"op|{self._put(str(saved))}")]]))

    # ================================================================
    # Кнопки
    # ================================================================
    def on_callback(self, cq: dict) -> None:
        user = cq.get("from") or {}
        cid = cq["id"]
        if not self.ctx.is_authorized(user.get("id")):
            self.api.answer_callback(cid, "⛔ Нет доступа", alert=True)
            return
        chat_id = cq["message"]["chat"]["id"]
        mid = cq["message"]["message_id"]
        data = cq.get("data") or ""
        kind, _, rest = data.partition("|")

        if kind == "a":
            name, _, arg = rest.partition("|")
            self.run_action(chat_id, None, name, arg, user=user, callback_id=cid)
            return
        if kind == "y":
            payload = self._store.pop(rest, None)
            if not payload:
                self.api.answer_callback(cid, "Кнопка устарела, повторите команду", alert=True)
                return
            self.api.answer_callback(cid, "Выполняю…")
            self.run_action(chat_id, None, payload[0], payload[1], confirmed=True, message_id=mid, user=user)
            return

        self.api.answer_callback(cid)
        if kind == "n":
            self.edit_or_send(chat_id, mid, "Отменено.")
        elif kind == "x":
            self.pending.pop(chat_id, None)
            self.edit_or_send(chat_id, mid, "Отменено.")
        elif kind == "in":
            self.run_action(chat_id, None, rest, "", user=user)
        elif kind == "st":
            self.cmd_status(chat_id, "", {}, message_id=mid)
        elif kind == "ss":
            self.cmd_screenshot(chat_id, rest, {})
        elif kind == "ssd":
            self.api.send_chat_action(chat_id, "upload_document")
            img = screen.screenshot(quality=95, max_width=10000)
            self.api.send_document(chat_id, img, f"screenshot_{datetime.now():%Y%m%d_%H%M%S}.jpg")
        elif kind == "ps":
            self.cmd_processes(chat_id, rest or "cpu", None, message_id=mid)
        elif kind == "k":
            self.run_action(chat_id, None, "kill", rest, user=user)
        elif kind == "more":
            self.cmd_more(chat_id, "", None, message_id=mid)
        elif kind == "apps":
            self.cmd_apps(chat_id, message_id=mid)
        elif kind == "app":
            apps = list(self.ctx.config["apps"].items())
            if rest.isdigit() and int(rest) < len(apps):
                self.run_action(chat_id, None, "launch", str(apps[int(rest)][1]), user=user)
        elif kind == "cam":
            self.cmd_webcam(chat_id, "", None)
        elif kind == "ip":
            self.cmd_ip(chat_id, "", None)
        elif kind == "nt":
            self.cmd_notify(chat_id, "", None)
            self.cmd_more(chat_id, "", None, message_id=mid)
        elif kind == "wp":
            self.cmd_web(chat_id, "", None)
        elif kind == "wpr":
            from .auth import generate_password
            pwd = generate_password()
            self.ctx.web_auth.set_password(pwd)
            self.ctx.db.add_event("warning", "security", "Пароль веб-панели изменён через Telegram")
            self.send(chat_id, f"🔑 Новый пароль веб-панели: <code>{E(pwd)}</code>\n"
                               "Все прежние сеансы завершены. Рекомендуем удалить это сообщение.")
        elif kind == "wpl":
            n = self.ctx.web_auth.logout_all()
            self.send(chat_id, f"🚪 Завершено сеансов веб-панели: {max(n, 0)}")
        elif kind == "log":
            self.cmd_log(chat_id, "", None, message_id=mid, mode=rest or "events")
        elif kind == "jl":
            self.cmd_jobs(chat_id, message_id=mid)
        elif kind == "j":
            job = self.ctx.db.get_job(int(rest)) if rest.isdigit() else None
            if job:
                self.api.send_long(chat_id, f"📋 <b>#{job['id']} {E(job['title'])}</b>", job["output"] or "",
                                   filename=f"job_{job['id']}.txt")
        elif kind == "acts":
            self.cmd_actions(chat_id, "", None)
        elif kind == "tl":
            self.cmd_tasks(chat_id, "", None, message_id=mid)
        elif kind == "tt" and rest.isdigit():
            t = self.ctx.db.get_task(int(rest))
            if t:
                self.ctx.db.set_task_enabled(t["id"], not t["enabled"])
            self.cmd_tasks(chat_id, "", None, message_id=mid)
        elif kind == "td" and rest.isdigit():
            self.ctx.db.delete_task(int(rest))
            self.cmd_tasks(chat_id, "", None, message_id=mid)
        elif kind == "f" and rest.isdigit():
            self.fb_open(chat_id, int(rest), mid)
        elif kind == "fu":
            st = self.fb.get(chat_id) or {}
            parent = self.ctx.files.parent(st["path"]) if st.get("path") else None
            self.fb_show(chat_id, parent, message_id=mid)
        elif kind == "fr":
            self.fb_show(chat_id, None, message_id=mid)
        elif kind == "fp" and rest.isdigit():
            st = self.fb.get(chat_id) or {}
            self.fb_show(chat_id, st.get("path"), page=int(rest), message_id=mid)
        elif kind == "op":
            payload = self._store.get(rest)
            if payload:
                self.run_action(chat_id, None, "launch", payload[0], user=user)
