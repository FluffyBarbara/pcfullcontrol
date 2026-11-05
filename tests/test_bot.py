"""Проверка Telegram-бота на поддельном API (без сети)."""

OWNER = {"id": 111, "username": "owner", "first_name": "Хозяин"}
STRANGER = {"id": 999, "username": "stranger"}


def msg(text, user=OWNER):
    return {"message_id": 1, "chat": {"id": user["id"], "type": "private"}, "from": user, "text": text}


def cb(data, user=OWNER):
    return {"id": "cb1", "from": user, "data": data,
            "message": {"message_id": 5, "chat": {"id": user["id"], "type": "private"}}}


def test_stranger_is_rejected(bot_ctx):
    ctx, bot, fake = bot_ctx
    bot.on_message(msg("/status", STRANGER))
    assert "Нет доступа" in fake.texts()[0]
    assert "999" in fake.texts()[0]


def test_pairing(bot_ctx):
    ctx, bot, fake = bot_ctx
    bot.on_message(msg("/pair WRONG", STRANGER))
    assert "Неверный код" in fake.texts()[-1]
    code = ctx.pairing_code()
    bot.on_message(msg(f"/pair {code.lower()}", STRANGER))
    assert ctx.is_authorized(999)
    assert ctx.pairing_code() != code  # код одноразовый


def test_menu_and_status(bot_ctx):
    ctx, bot, fake = bot_ctx
    bot.on_message(msg("/start"))
    assert "на связи" in fake.texts()[-1]
    bot.on_message(msg("📊 Статус"))
    assert "CPU" in fake.texts()[-1]
    for button in ("⚡ Питание", "🔊 Медиа", "🔄 Обновления", "🛠 Ещё", "📜 Журнал", "⏰ Планировщик"):
        bot.on_message(msg(button))
        assert fake.sent[-1]["kb"], button


def test_dangerous_action_needs_confirmation(bot_ctx, monkeypatch):
    ctx, bot, fake = bot_ctx
    called = []
    monkeypatch.setattr(ctx.actions.actions["shutdown"], "func", lambda arg: called.append(arg) or "ок")
    monkeypatch.setattr(ctx.notifier, "flush", lambda t=0: None)
    bot.on_message(msg("/shutdown 30"))
    assert "Подтвердите" in fake.texts()[-1] and not called
    key = fake.sent[-1]["kb"]["inline_keyboard"][0][0]["callback_data"]
    bot.on_callback(cb(key))
    assert called == ["30"]
    assert ctx.db.get_setting("last_power_action")["action"] == "shutdown"
    # повторное нажатие той же кнопки не выполняет действие второй раз
    bot.on_callback(cb(key))
    assert called == ["30"]


def test_pending_input(bot_ctx, monkeypatch):
    ctx, bot, fake = bot_ctx
    got = []
    monkeypatch.setattr(ctx.actions.actions["message"], "func", lambda arg: got.append(arg) or "показано")
    bot.on_callback(cb("in|message"))
    assert "Введите" in fake.texts()[-1]
    bot.on_message(msg("Ужин готов!"))
    assert got == ["Ужин готов!"]


def test_scheduler_commands(bot_ctx):
    ctx, bot, fake = bot_ctx
    bot.on_message(msg("/in 30m shutdown"))
    assert "добавлена" in fake.texts()[-1]
    bot.on_message(msg("/at 23:30 перезагрузка"))
    assert "Перезагрузить" in fake.texts()[-1]
    bot.on_message(msg("/daily 08:00 будни notify Подъём!"))
    assert "по будням" in fake.texts()[-1]
    bot.on_message(msg("/daily 08:00 notify"))
    assert "нужен параметр" in fake.texts()[-1]
    bot.on_message(msg("/in soon shutdown"))
    assert "❌" in fake.texts()[-1]
    assert len(ctx.db.list_tasks()) == 3
    bot.on_message(msg("/tasks"))
    assert "#1" in fake.texts()[-1]
    bot.on_callback(cb("td|1"))
    assert len(ctx.db.list_tasks()) == 2


def test_file_browser_and_upload(bot_ctx, tmp_path):
    ctx, bot, fake = bot_ctx
    d = tmp_path / "share"
    d.mkdir()
    (d / "doc.txt").write_text("содержимое", encoding="utf-8")
    bot.on_message(msg(f"/files {d}"))
    assert "doc.txt" in str(fake.sent[-1]["kb"])
    bot.on_callback(cb("f|0"))
    assert fake.sent[-1]["kind"] == "document" and fake.sent[-1]["filename"] == "doc.txt"

    upload = msg("")
    upload["document"] = {"file_id": "x", "file_name": "from_phone.txt", "file_size": 10}
    bot.on_message(upload)
    saved = ctx.config.upload_dir / "from_phone.txt"
    assert saved.read_bytes() == b"hello from phone"


def test_processes_and_log(bot_ctx):
    ctx, bot, fake = bot_ctx
    bot.on_message(msg("🧩 Процессы"))
    assert "Процессы" in fake.texts()[-1]
    bot.on_callback(cb("ps|mem"))
    assert "память" in fake.texts()[-1]
    bot.on_callback(cb("log|commands"))
    assert "Последние команды" in fake.texts()[-1]


def test_unknown_text(bot_ctx):
    ctx, bot, fake = bot_ctx
    bot.on_message(msg("абракадабра"))
    assert "Не понял" in fake.texts()[-1]


def test_group_chats_ignored(bot_ctx):
    ctx, bot, fake = bot_ctx
    m = msg("/status")
    m["chat"]["type"] = "group"
    bot.on_message(m)
    assert fake.sent == []
