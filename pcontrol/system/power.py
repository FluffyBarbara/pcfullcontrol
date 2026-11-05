"""Питание: выключение, перезагрузка, сон, блокировка и т.д.

Команды выполняются с небольшой задержкой, чтобы ответ успел уйти в Telegram/браузер.
"""
from __future__ import annotations

import logging
import threading

from ..platform_utils import IS_LINUX, IS_MAC, IS_WINDOWS, run, spawn, which

log = logging.getLogger(__name__)

DELAY_SECONDS = 3


def _later(func, delay: float = DELAY_SECONDS) -> None:
    t = threading.Timer(delay, func)
    t.daemon = True
    t.start()


def _minutes(arg: str | int | None) -> int:
    try:
        return max(0, int(float(str(arg).strip()))) if arg not in (None, "") else 0
    except ValueError:
        raise ValueError("Укажите задержку в минутах, например: 30")


def _power_unix(kind: str, mins: int) -> tuple[int, str]:
    """kind: 'h' — выключение, 'r' — перезагрузка."""
    if mins == 0:
        def do():
            if IS_MAC:
                run(["sudo", "-n", "shutdown", f"-{kind}", "now"])
            elif run(["systemctl", "poweroff" if kind == "h" else "reboot"])[0] != 0:
                run(["shutdown", f"-{kind}", "now"])
        _later(do)
        return 0, ""
    cmd = ["shutdown", f"-{kind}", f"+{mins}"]
    return run(["sudo", "-n"] + cmd if IS_MAC else cmd)


def shutdown(arg: str = "") -> str:
    mins = _minutes(arg)
    if IS_WINDOWS:
        code, out = run(["shutdown", "/s", "/f", "/t", str(max(mins * 60, DELAY_SECONDS))])
    else:
        code, out = _power_unix("h", mins)
    if code != 0:
        raise RuntimeError(out or "не удалось выполнить выключение")
    return f"Компьютер будет выключен через {mins} мин." if mins else "Выключаю компьютер…"


def reboot(arg: str = "") -> str:
    mins = _minutes(arg)
    if IS_WINDOWS:
        code, out = run(["shutdown", "/r", "/f", "/t", str(max(mins * 60, DELAY_SECONDS))])
    else:
        code, out = _power_unix("r", mins)
    if code != 0:
        raise RuntimeError(out or "не удалось выполнить перезагрузку")
    return f"Перезагрузка через {mins} мин." if mins else "Перезагружаю компьютер…"


def cancel_shutdown(arg: str = "") -> str:
    if IS_WINDOWS:
        code, out = run(["shutdown", "/a"])
    elif IS_MAC:
        code, out = run(["sudo", "-n", "killall", "shutdown"])
    else:
        code, out = run(["shutdown", "-c"])
    if code != 0:
        return "Нет запланированного выключения (или его не удалось отменить)."
    return "Запланированное выключение/перезагрузка отменены."


def sleep(arg: str = "") -> str:
    def do():
        if IS_WINDOWS:
            import ctypes
            # Если включена гибернация, Windows может уйти в неё вместо сна — это особенность ОС.
            ctypes.windll.powrprof.SetSuspendState(0, 1, 0)
        elif IS_MAC:
            run(["pmset", "sleepnow"])
        else:
            run(["systemctl", "suspend"])
    _later(do)
    return "Перевожу компьютер в спящий режим…"


def hibernate(arg: str = "") -> str:
    def do():
        if IS_WINDOWS:
            run(["shutdown", "/h"])
        elif IS_MAC:
            run(["pmset", "sleepnow"])
        else:
            run(["systemctl", "hibernate"])
    _later(do)
    return "Перевожу компьютер в гибернацию…"


def lock(arg: str = "") -> str:
    if IS_WINDOWS:
        import ctypes
        ok = ctypes.windll.user32.LockWorkStation()
        if not ok:
            raise RuntimeError("Не удалось заблокировать (агент должен работать в сеансе пользователя)")
    elif IS_MAC:
        code, out = run(["pmset", "displaysleepnow"])
    elif IS_LINUX:
        code, out = run(["loginctl", "lock-sessions"])
        if code != 0:
            for cmd in (["xdg-screensaver", "lock"], ["gnome-screensaver-command", "-l"],
                        ["dm-tool", "lock"]):
                if which(cmd[0]) and run(cmd)[0] == 0:
                    break
            else:
                raise RuntimeError(out or "не удалось заблокировать экран")
    return "Экран заблокирован 🔒"


def logoff(arg: str = "") -> str:
    def do():
        if IS_WINDOWS:
            run(["shutdown", "/l"])
        elif IS_MAC:
            run(["osascript", "-e", 'tell application "System Events" to log out'])
        else:
            run(["loginctl", "terminate-user", __import__("getpass").getuser()])
    _later(do)
    return "Выполняю выход из системы…"


def monitor_off(arg: str = "") -> str:
    if IS_WINDOWS:
        import ctypes
        HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER = 0xFFFF, 0x0112, 0xF170
        ctypes.windll.user32.PostMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)
    elif IS_MAC:
        run(["pmset", "displaysleepnow"])
    else:
        if which("xset"):
            spawn(["xset", "dpms", "force", "off"])
        else:
            raise RuntimeError("Нужна утилита xset")
    return "Экран выключен 🌑"
