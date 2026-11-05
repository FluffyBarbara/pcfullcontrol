"""Разное: открыть ссылку, запустить программу, сообщение на экран, озвучка, буфер обмена, терминал."""
from __future__ import annotations

import os
import shlex
import threading
import webbrowser

from ..platform_utils import IS_MAC, IS_WINDOWS, run, run_powershell, spawn, which


def open_url(arg: str) -> str:
    url = (arg or "").strip()
    if not url:
        raise ValueError("Укажите ссылку")
    if "://" not in url:
        url = "https://" + url
    if not url.lower().startswith(("http://", "https://")):
        raise ValueError("Поддерживаются только ссылки http/https")
    webbrowser.open(url)
    return f"Открываю {url}"


def launch(arg: str) -> str:
    target = (arg or "").strip()
    if not target:
        raise ValueError("Укажите программу или путь")
    if target.lower().startswith(("http://", "https://")):
        return open_url(target)
    if IS_WINDOWS:
        try:
            os.startfile(target)  # type: ignore[attr-defined]
        except OSError:
            spawn(f'start "" {target}', shell=True)
    elif IS_MAC:
        if os.path.exists(target) or target.endswith(".app"):
            spawn(["open", target])
        else:
            spawn(["open", "-a", target])
    else:
        if os.path.exists(target) and not os.access(target, os.X_OK):
            spawn(["xdg-open", target])
        else:
            spawn(shlex.split(target))
    return f"Запущено: {target}"


def show_message(arg: str) -> str:
    text = (arg or "").strip()
    if not text:
        raise ValueError("Укажите текст сообщения")
    title = "Сообщение с телефона"
    if IS_WINDOWS:
        import ctypes

        def box():
            MB_OK, MB_ICONINFORMATION, MB_TOPMOST, MB_SETFOREGROUND = 0x0, 0x40, 0x40000, 0x10000
            ctypes.windll.user32.MessageBoxW(0, text, title, MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND)
        threading.Thread(target=box, daemon=True).start()
    elif IS_MAC:
        safe = text.replace('"', '\\"')
        spawn(["osascript", "-e", f'display dialog "{safe}" with title "{title}" buttons {{"OK"}}'])
    else:
        if which("zenity"):
            spawn(["zenity", "--info", "--title", title, "--text", text])
        elif which("notify-send"):
            spawn(["notify-send", title, text])
        else:
            raise RuntimeError("Установите zenity или notify-send")
    return "Сообщение показано на экране 💬"


def say(arg: str) -> str:
    text = (arg or "").strip()
    if not text:
        raise ValueError("Укажите текст для озвучки")
    if IS_WINDOWS:
        safe = text.replace("'", "''")
        script = ("Add-Type -AssemblyName System.Speech; "
                  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                  f"$s.Speak('{safe}')")
        threading.Thread(target=run_powershell, args=(script, 120), daemon=True).start()
    elif IS_MAC:
        spawn(["say", text])
    elif which("spd-say"):
        spawn(["spd-say", "-l", "ru", text])
    elif which("espeak"):
        spawn(["espeak", "-v", "ru", text])
    else:
        raise RuntimeError("Установите spd-say или espeak")
    return "Озвучиваю 🗣"


def clipboard_get(arg: str = "") -> str:
    if IS_WINDOWS:
        code, out = run_powershell("Get-Clipboard -Raw", timeout=10)
    elif IS_MAC:
        code, out = run(["pbpaste"])
    elif which("xclip"):
        code, out = run(["xclip", "-selection", "clipboard", "-o"])
    elif which("wl-paste"):
        code, out = run(["wl-paste"])
    else:
        raise RuntimeError("Установите xclip или wl-clipboard")
    return out if out.strip() else "(буфер обмена пуст)"


def clipboard_set(arg: str) -> str:
    import subprocess
    text = arg or ""
    if IS_WINDOWS:
        safe = text.replace("'", "''")
        code, out = run_powershell(f"Set-Clipboard -Value '{safe}'", timeout=15)
        if code != 0:
            raise RuntimeError(out or "Не удалось записать в буфер обмена")
    elif IS_MAC:
        subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=10)
    elif which("xclip"):
        subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), timeout=10)
    elif which("wl-copy"):
        subprocess.run(["wl-copy"], input=text.encode("utf-8"), timeout=10)
    else:
        raise RuntimeError("Установите xclip или wl-clipboard")
    return "Текст скопирован в буфер обмена ПК 📋"


def shell(arg: str, timeout: float = 120) -> str:
    cmd = (arg or "").strip()
    if not cmd:
        raise ValueError("Укажите команду")
    if IS_WINDOWS:
        code, out = run_powershell(cmd, timeout=timeout)
    else:
        code, out = run(["/bin/sh", "-c", cmd], timeout=timeout)
    return f"$ {cmd}\n{out or '(нет вывода)'}\n[код выхода: {code}]"


def empty_recycle_bin(arg: str = "") -> str:
    if IS_WINDOWS:
        code, out = run_powershell("Clear-RecycleBin -Force -ErrorAction SilentlyContinue", timeout=120)
    elif IS_MAC:
        code, out = run(["osascript", "-e", 'tell application "Finder" to empty trash'])
    else:
        trash = os.path.expanduser("~/.local/share/Trash")
        code, out = run(["/bin/sh", "-c", f'rm -rf "{trash}/files/"* "{trash}/info/"*'])
    return "Корзина очищена 🗑"
