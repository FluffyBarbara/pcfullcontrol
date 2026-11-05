"""Сбор информации о системе."""
from __future__ import annotations

import html
import platform
import socket
import time
from datetime import datetime

import psutil
import requests

from ..platform_utils import IS_WINDOWS, run, which


def fmt_bytes(n: float | None) -> str:
    if n is None:
        return "—"
    n = float(n)
    for unit in ("Б", "КБ", "МБ", "ГБ", "ТБ"):
        if abs(n) < 1024 or unit == "ТБ":
            return f"{n:.0f} {unit}" if unit == "Б" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} ТБ"


def fmt_duration(seconds: float) -> str:
    seconds = int(max(0, seconds))
    d, rem = divmod(seconds, 86400)
    h, rem = divmod(rem, 3600)
    m, _ = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d} д")
    if h:
        parts.append(f"{h} ч")
    parts.append(f"{m} мин")
    return " ".join(parts)


def os_description() -> str:
    if IS_WINDOWS:
        rel, ver = platform.release(), platform.version()
        try:
            build = int(ver.split(".")[-1])
            if rel == "10" and build >= 22000:
                rel = "11"
        except ValueError:
            pass
        return f"Windows {rel} ({ver})"
    if platform.system() == "Darwin":
        return f"macOS {platform.mac_ver()[0]}"
    try:
        import distro  # type: ignore
        return distro.name(pretty=True)
    except Exception:
        pass
    try:
        with open("/etc/os-release", encoding="utf-8") as f:
            for line in f:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return f"{platform.system()} {platform.release()}"


def local_ips() -> list[str]:
    ips = []
    for name, addrs in psutil.net_if_addrs().items():
        for a in addrs:
            if a.family == socket.AF_INET and not a.address.startswith(("127.", "169.254.")):
                ips.append(a.address)
    return ips


def public_ip() -> str | None:
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com"):
        try:
            r = requests.get(url, timeout=5)
            if r.ok and r.text.strip():
                return r.text.strip()
        except requests.RequestException:
            continue
    return None


def disks() -> list[dict]:
    result = []
    for p in psutil.disk_partitions(all=False):
        if "cdrom" in p.opts or not p.fstype:
            continue
        if p.mountpoint.startswith(("/snap", "/boot/efi", "/var/lib/docker")) or p.fstype in ("squashfs", "overlay"):
            continue
        try:
            u = psutil.disk_usage(p.mountpoint)
        except (PermissionError, OSError):
            continue
        result.append({
            "mount": p.mountpoint, "fs": p.fstype, "total": u.total,
            "used": u.used, "free": u.free, "percent": u.percent,
        })
    return result


_temp_cache: tuple[float, float | None] = (0.0, None)


def cpu_temperature() -> float | None:
    """Температура CPU с кэшем: 20 с, а если датчик недоступен — 10 мин (в Windows опрос медленный)."""
    global _temp_cache
    ts, value = _temp_cache
    ttl = 20 if value is not None else 600
    if ts and time.time() - ts < ttl:
        return value
    value = _read_cpu_temperature()
    _temp_cache = (time.time(), value)
    return value


def _read_cpu_temperature() -> float | None:
    """psutil поддерживает Linux; в Windows пробуем WMI (нужны права админа)."""
    try:
        temps = psutil.sensors_temperatures()  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        temps = {}
    if temps:
        for key in ("coretemp", "k10temp", "zenpower", "cpu_thermal", "acpitz"):
            if key in temps and temps[key]:
                return max(t.current for t in temps[key])
        values = [t.current for entries in temps.values() for t in entries if t.current]
        if values:
            return max(values)
    if IS_WINDOWS:
        code, out = run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature "
             "-ErrorAction Stop | Select-Object -First 1).CurrentTemperature"],
            timeout=8,
        )
        try:
            if code == 0:
                return round(int(out.strip().splitlines()[0]) / 10 - 273.15, 1)
        except (ValueError, IndexError):
            pass
    return None


_gpu_cache: tuple[float, list] = (0.0, [])


def gpus() -> list[dict]:
    """Информация о видеокартах NVIDIA (если установлен nvidia-smi). Кэш 10 с."""
    global _gpu_cache
    if time.time() - _gpu_cache[0] < 10:
        return _gpu_cache[1]
    result: list[dict] = []
    if which("nvidia-smi"):
        code, out = run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            timeout=8,
        )
        if code == 0:
            for line in out.splitlines():
                parts = [x.strip() for x in line.split(",")]
                if len(parts) == 5:
                    try:
                        result.append({
                            "name": parts[0], "util": float(parts[1]), "temp": float(parts[2]),
                            "mem_used": float(parts[3]) * 1024 * 1024,
                            "mem_total": float(parts[4]) * 1024 * 1024,
                        })
                    except ValueError:
                        pass
    _gpu_cache = (time.time(), result)
    return result


def battery() -> dict | None:
    try:
        b = psutil.sensors_battery()
    except (AttributeError, OSError, RuntimeError):
        return None
    if b is None:
        return None
    secs = b.secsleft if isinstance(b.secsleft, int) and b.secsleft > 0 else None
    return {"percent": round(b.percent), "plugged": bool(b.power_plugged), "secs_left": secs}


def get_status(cpu_interval: float = 0.5) -> dict:
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    net = psutil.net_io_counters()
    boot = psutil.boot_time()
    try:
        freq = psutil.cpu_freq()
        freq_mhz = round(freq.current) if freq else None
    except Exception:
        freq_mhz = None
    per_core = psutil.cpu_percent(interval=cpu_interval, percpu=True)
    cpu_total = round(sum(per_core) / len(per_core), 1) if per_core else 0.0
    try:
        users = sorted({u.name for u in psutil.users()})
    except Exception:
        users = []
    return {
        "hostname": socket.gethostname(),
        "os": os_description(),
        "boot_time": boot,
        "uptime": time.time() - boot,
        "cpu": {
            "percent": cpu_total,
            "cores": psutil.cpu_count(logical=False),
            "threads": psutil.cpu_count(logical=True),
            "freq_mhz": freq_mhz,
            "per_core": per_core,
            "name": platform.processor(),
        },
        "ram": {"total": vm.total, "used": vm.total - vm.available, "percent": vm.percent},
        "swap": {"total": sw.total, "used": sw.used, "percent": sw.percent},
        "disks": disks(),
        "net": {"sent": net.bytes_sent, "recv": net.bytes_recv, "ips": local_ips()},
        "battery": battery(),
        "temp": cpu_temperature(),
        "gpus": gpus(),
        "users": users,
        "process_count": len(psutil.pids()),
    }


def _bar(percent: float, width: int = 10) -> str:
    filled = int(round(percent / 100 * width))
    return "▓" * filled + "░" * (width - filled)


def format_status(s: dict, pc_name: str = "") -> str:
    """Статус в формате HTML для Telegram."""
    e = html.escape
    lines = [
        f"🖥 <b>{e(pc_name or s['hostname'])}</b> — {e(s['os'])}",
        f"⏱ Работает: {fmt_duration(s['uptime'])} "
        f"(с {datetime.fromtimestamp(s['boot_time']).strftime('%d.%m %H:%M')})",
        "",
        f"🧠 CPU: <b>{s['cpu']['percent']:.0f}%</b> {_bar(s['cpu']['percent'])} "
        f"({s['cpu']['cores']}/{s['cpu']['threads']} ядер"
        + (f", {s['cpu']['freq_mhz']} МГц" if s['cpu']['freq_mhz'] else "") + ")",
        f"💾 RAM: <b>{s['ram']['percent']:.0f}%</b> {_bar(s['ram']['percent'])} "
        f"{fmt_bytes(s['ram']['used'])} / {fmt_bytes(s['ram']['total'])}",
    ]
    if s.get("temp") is not None:
        lines.append(f"🌡 Температура CPU: <b>{s['temp']:.0f}°C</b>")
    for g in s.get("gpus") or []:
        lines.append(
            f"🎮 {e(g['name'])}: {g['util']:.0f}%, {g['temp']:.0f}°C, "
            f"{fmt_bytes(g['mem_used'])} / {fmt_bytes(g['mem_total'])}"
        )
    lines.append("")
    for d in s["disks"]:
        lines.append(
            f"💽 {e(d['mount'])} {_bar(d['percent'])} свободно {fmt_bytes(d['free'])} "
            f"из {fmt_bytes(d['total'])}"
        )
    b = s.get("battery")
    if b:
        state = "🔌 заряжается" if b["plugged"] else "🔋 от батареи"
        extra = f", осталось {fmt_duration(b['secs_left'])}" if b.get("secs_left") and not b["plugged"] else ""
        lines.append(f"🔋 Батарея: {b['percent']}% ({state}{extra})")
    lines.append("")
    lines.append(f"🌐 IP: {e(', '.join(s['net']['ips']) or '—')}")
    lines.append(f"📶 Трафик: ↑ {fmt_bytes(s['net']['sent'])} ↓ {fmt_bytes(s['net']['recv'])}")
    lines.append(f"👤 Пользователи: {e(', '.join(s['users']) or '—')} · процессов: {s['process_count']}")
    return "\n".join(lines)
