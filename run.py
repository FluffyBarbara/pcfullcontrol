#!/usr/bin/env python3
"""PC Full Control — запуск агента.

    python run.py                  # обычный запуск
    python run.py --set-password   # задать пароль веб-панели
    python run.py --pair-code      # показать код привязки Telegram
"""
from __future__ import annotations

import argparse
import getpass
import logging
import logging.handlers
import os
import shutil
import sys
import time

# pythonw.exe (запуск без окна) не имеет консоли — перенаправляем вывод в никуда
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

from pcontrol import __version__  # noqa: E402
from pcontrol.config import BASE_DIR, DEFAULT_CONFIG_PATH, load_config  # noqa: E402

log = logging.getLogger("pcontrol")


def setup_logging(data_dir, debug: bool) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if debug else logging.INFO)
    fh = logging.handlers.RotatingFileHandler(data_dir / "pcontrol.log", maxBytes=2_000_000,
                                              backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    root.addHandler(fh)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.addHandler(sh)
    for noisy in ("urllib3", "uvicorn.access", "PIL", "multipart"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def main() -> int:
    parser = argparse.ArgumentParser(description="PC Full Control — управление ПК с телефона")
    parser.add_argument("--config", help="путь к config.yaml")
    parser.add_argument("--set-password", action="store_true", help="задать пароль веб-панели")
    parser.add_argument("--pair-code", action="store_true", help="показать код привязки Telegram")
    parser.add_argument("--no-web", action="store_true", help="не запускать веб-панель")
    parser.add_argument("--no-bot", action="store_true", help="не запускать Telegram-бота")
    parser.add_argument("--debug", action="store_true", help="подробный лог")
    args = parser.parse_args()

    if not args.config and not DEFAULT_CONFIG_PATH.exists():
        example = BASE_DIR / "config.example.yaml"
        if example.exists():
            shutil.copy(example, DEFAULT_CONFIG_PATH)
            print(f"Создан файл настроек {DEFAULT_CONFIG_PATH}. Укажите в нём токен Telegram-бота.")

    cfg = load_config(args.config)
    setup_logging(cfg.data_dir, args.debug)

    from pcontrol.core import AppContext
    ctx = AppContext(cfg)

    if args.set_password:
        pwd = getpass.getpass("Новый пароль веб-панели: ")
        if pwd != getpass.getpass("Повторите пароль: "):
            print("Пароли не совпадают")
            return 1
        try:
            ctx.web_auth.set_password(pwd)
        except ValueError as e:
            print(e)
            return 1
        print("Пароль сохранён. Все сеансы веб-панели завершены.")
        return 0
    if args.pair_code:
        print(f"Отправьте боту команду: /pair {ctx.pairing_code()}")
        return 0

    log.info("PC Full Control %s запускается. Данные: %s", __version__, cfg.data_dir)
    web_enabled = cfg["web"]["enabled"] and not args.no_web

    new_password = ctx.web_auth.ensure_password() if web_enabled else None
    if new_password:
        log.warning("=" * 60)
        log.warning("Пароль веб-панели (сохраните его!): %s", new_password)
        log.warning("Сменить: python run.py --set-password  или в Telegram: /web")
        log.warning("=" * 60)
        if ctx.authorized_ids():
            ctx.notifier.notify(f"🔑 Пароль веб-панели: <code>{new_password}</code>", category="security",
                                log_event=False)
    if ctx.tg and not ctx.authorized_ids():
        log.warning("Привязка Telegram: отправьте боту команду  /pair %s", ctx.pairing_code())
    if not ctx.tg:
        log.warning("Telegram не настроен — укажите telegram.token в %s", cfg.path)

    ctx.start_services(bot=not args.no_bot)

    try:
        if web_enabled:
            import uvicorn

            from pcontrol.system.info import local_ips
            from pcontrol.web.server import create_app

            host, port = cfg["web"]["host"], int(cfg["web"]["port"])
            urls = [f"http://{ip}:{port}" for ip in local_ips()] if host == "0.0.0.0" else [f"http://{host}:{port}"]
            log.info("Веб-панель: %s", ", ".join(urls) or f"http://localhost:{port}")
            uvicorn.run(create_app(ctx), host=host, port=port, log_config=None, log_level="warning",
                        access_log=False)
        else:
            while not ctx.stop_event.is_set():
                time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        log.info("Агент останавливается")
        ctx.shutdown_components()
    return 0


if __name__ == "__main__":
    sys.exit(main())
