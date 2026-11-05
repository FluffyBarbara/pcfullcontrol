"""Громкость и управление воспроизведением."""
from __future__ import annotations

import logging
import time

from ..platform_utils import IS_MAC, IS_WINDOWS, run, which

log = logging.getLogger(__name__)

# Виртуальные клавиши Windows
VK = {
    "mute": 0xAD, "down": 0xAE, "up": 0xAF,
    "next": 0xB0, "prev": 0xB1, "stop": 0xB2, "play": 0xB3,
}


def _press(vk: int, times: int = 1) -> None:
    import ctypes
    KEYEVENTF_KEYUP = 0x2
    for _ in range(times):
        ctypes.windll.user32.keybd_event(vk, 0, 0, 0)
        ctypes.windll.user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.01)


def _win_endpoint():
    """Интерфейс громкости через pycaw (если установлен)."""
    try:
        import comtypes  # type: ignore
        comtypes.CoInitialize()
    except Exception:
        pass
    from pycaw.pycaw import AudioUtilities  # type: ignore
    speakers = AudioUtilities.GetSpeakers()
    if hasattr(speakers, "EndpointVolume"):  # pycaw >= 2025
        return speakers.EndpointVolume
    from ctypes import POINTER, cast
    from comtypes import CLSCTX_ALL  # type: ignore
    from pycaw.pycaw import IAudioEndpointVolume  # type: ignore
    iface = speakers.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
    return cast(iface, POINTER(IAudioEndpointVolume))


def get_volume() -> int | None:
    try:
        if IS_WINDOWS:
            ep = _win_endpoint()
            return round(ep.GetMasterVolumeLevelScalar() * 100)
        if IS_MAC:
            code, out = run(["osascript", "-e", "output volume of (get volume settings)"])
            return int(out.strip()) if code == 0 else None
        if which("pactl"):
            code, out = run(["pactl", "get-sink-volume", "@DEFAULT_SINK@"])
            if code == 0 and "%" in out:
                return int(out.split("%")[0].split()[-1])
        if which("amixer"):
            code, out = run(["amixer", "get", "Master"])
            if code == 0 and "[" in out:
                return int(out.split("[")[1].split("%")[0])
    except Exception as e:
        log.debug("get_volume: %s", e)
    return None


def set_volume(arg: str) -> str:
    try:
        level = max(0, min(100, int(str(arg).strip().rstrip("%"))))
    except ValueError:
        raise ValueError("Укажите громкость от 0 до 100")
    if IS_WINDOWS:
        try:
            ep = _win_endpoint()
            ep.SetMute(0, None)
            ep.SetMasterVolumeLevelScalar(level / 100, None)
        except Exception:
            # Запасной способ без pycaw: шаг клавиш громкости = 2%
            _press(VK["down"], 50)
            _press(VK["up"], level // 2)
    elif IS_MAC:
        run(["osascript", "-e", f"set volume output volume {level}"])
    elif which("pactl"):
        run(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "0"])
        run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", f"{level}%"])
    elif which("amixer"):
        run(["amixer", "set", "Master", f"{level}%", "unmute"])
    else:
        raise RuntimeError("Не найдено средство управления громкостью (pactl/amixer)")
    return f"Громкость: {level}%"


def _step(direction: str, steps: int = 5) -> str:
    if IS_WINDOWS:
        _press(VK[direction], steps)
    elif IS_MAC:
        cur = get_volume() or 0
        new = max(0, min(100, cur + (10 if direction == "up" else -10)))
        run(["osascript", "-e", f"set volume output volume {new}"])
    elif which("pactl"):
        run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", ("+" if direction == "up" else "-") + "10%"])
    elif which("amixer"):
        run(["amixer", "set", "Master", "10%" + ("+" if direction == "up" else "-")])
    vol = get_volume()
    return f"Громкость: {vol}%" if vol is not None else ("Громче 🔊" if direction == "up" else "Тише 🔉")


def volume_up(arg: str = "") -> str:
    return _step("up")


def volume_down(arg: str = "") -> str:
    return _step("down")


def mute(arg: str = "") -> str:
    if IS_WINDOWS:
        try:
            ep = _win_endpoint()
            ep.SetMute(0 if ep.GetMute() else 1, None)
            return "Звук выключен 🔇" if ep.GetMute() else "Звук включён 🔊"
        except Exception:
            _press(VK["mute"])
    elif IS_MAC:
        code, out = run(["osascript", "-e", "output muted of (get volume settings)"])
        run(["osascript", "-e", f"set volume output muted {'false' if 'true' in out else 'true'}"])
    elif which("pactl"):
        run(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"])
    elif which("amixer"):
        run(["amixer", "set", "Master", "toggle"])
    return "Звук: вкл/выкл 🔇"


def _media(key: str, playerctl_cmd: str, mac_key: int) -> None:
    if IS_WINDOWS:
        _press(VK[key])
    elif IS_MAC:
        run(["osascript", "-e", f'tell application "System Events" to key code {mac_key}'])
    elif which("playerctl"):
        run(["playerctl", playerctl_cmd])
    else:
        raise RuntimeError("Установите playerctl для управления плеером")


def play_pause(arg: str = "") -> str:
    _media("play", "play-pause", 100)
    return "⏯ Пауза/воспроизведение"


def next_track(arg: str = "") -> str:
    _media("next", "next", 101)
    return "⏭ Следующий трек"


def prev_track(arg: str = "") -> str:
    _media("prev", "previous", 98)
    return "⏮ Предыдущий трек"
