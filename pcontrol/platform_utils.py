"""Определение ОС и запуск внешних команд."""
from __future__ import annotations

import locale
import logging
import os
import re
import shutil
import subprocess
import sys

log = logging.getLogger(__name__)

IS_WINDOWS = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
_SPINNER_RE = re.compile(r"^[\s\-\\|/█▒░■□▓]*$")


def os_key() -> str:
    if IS_WINDOWS:
        return "windows"
    if IS_MAC:
        return "mac"
    return "linux"


def decode_output(data: bytes | None) -> str:
    if not data:
        return ""
    encodings = ["utf-8"]
    if IS_WINDOWS:
        encodings += ["cp866", "cp1251"]
    encodings.append(locale.getpreferredencoding(False))
    for enc in encodings:
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


def clean_output(text: str) -> str:
    """Убирает ANSI-коды, индикаторы прогресса и спиннеры (winget, apt и т.п.)."""
    lines = []
    for raw in _ANSI_RE.sub("", text).split("\n"):
        line = raw.rstrip("\r").split("\r")[-1].rstrip()
        if line and _SPINNER_RE.match(line):
            continue
        lines.append(line)
    out = "\n".join(lines)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def _popen_kwargs() -> dict:
    return {"creationflags": CREATE_NO_WINDOW} if IS_WINDOWS else {}


def run(cmd: list[str] | str, timeout: float = 60, shell: bool = False,
        cwd: str | None = None) -> tuple[int, str]:
    """Запустить команду и вернуть (код выхода, вывод)."""
    try:
        p = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            timeout=timeout,
            shell=shell,
            cwd=cwd,
            **_popen_kwargs(),
        )
        return p.returncode, clean_output(decode_output(p.stdout))
    except subprocess.TimeoutExpired as e:
        return -1, clean_output(decode_output(e.stdout)) + f"\n[превышено время ожидания: {timeout:.0f} с]"
    except FileNotFoundError as e:
        return -1, f"Команда не найдена: {e.filename or cmd}"
    except OSError as e:
        return -1, f"Ошибка запуска: {e}"


def run_powershell(script: str, timeout: float = 120) -> tuple[int, str]:
    prefix = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; "
    return run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-Command", prefix + script],
        timeout=timeout,
    )


def spawn(cmd: list[str] | str, shell: bool = False) -> None:
    """Запустить процесс и не ждать его завершения."""
    kwargs: dict = {}
    if IS_WINDOWS:
        kwargs["creationflags"] = DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(cmd, shell=shell, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, **kwargs)


def which(name: str) -> str | None:
    return shutil.which(name)


def is_admin() -> bool:
    try:
        if IS_WINDOWS:
            import ctypes
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        return os.geteuid() == 0
    except Exception:
        return False


def privileged(cmd: list[str]) -> list[str]:
    """Для Linux/macOS: добавить sudo -n, если агент запущен не от root."""
    if IS_WINDOWS or is_admin():
        return cmd
    return ["sudo", "-n"] + cmd
