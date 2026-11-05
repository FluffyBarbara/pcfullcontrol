"""Список процессов и их завершение."""
from __future__ import annotations

import os
import time

import psutil

PROTECTED_NAMES = {
    "system", "system idle process", "csrss.exe", "wininit.exe", "winlogon.exe",
    "smss.exe", "services.exe", "lsass.exe", "svchost.exe", "dwm.exe",
    "systemd", "init", "kthreadd", "launchd", "kernel_task",
}


def list_processes(sort: str = "cpu", limit: int = 30, query: str = "") -> list[dict]:
    procs = []
    for p in psutil.process_iter(["pid", "name"]):
        try:
            p.cpu_percent(None)
            procs.append(p)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    time.sleep(0.5)
    ncpu = psutil.cpu_count() or 1
    q = query.lower().strip()
    result = []
    for p in procs:
        try:
            name = p.info["name"] or "?"
            if q and q not in name.lower() and q != str(p.pid):
                continue
            mem = p.memory_info().rss
            result.append({
                "pid": p.pid,
                "name": name,
                "cpu": round(p.cpu_percent(None) / ncpu, 1),
                "mem": mem,
                "mem_percent": round(p.memory_percent(), 1),
                "user": _safe(p.username),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
    key = {"mem": lambda x: x["mem"], "name": lambda x: x["name"].lower()}.get(sort, lambda x: x["cpu"])
    result.sort(key=key, reverse=(sort != "name"))
    return result[:limit] if limit else result


def _safe(fn):
    try:
        return fn()
    except Exception:
        return ""


def kill(target: str) -> str:
    """Завершить процесс по PID или имени (например, chrome.exe или chrome)."""
    target = (target or "").strip()
    if not target:
        raise ValueError("Укажите PID или имя процесса")
    me = os.getpid()
    victims: list[psutil.Process] = []
    if target.isdigit():
        try:
            victims = [psutil.Process(int(target))]
        except psutil.NoSuchProcess:
            victims = []
    else:
        t = target.lower()
        for p in psutil.process_iter(["name"]):
            name = (p.info["name"] or "").lower()
            if name == t or name == t + ".exe" or name.removesuffix(".exe") == t:
                victims.append(p)
    if not victims:
        raise ValueError(f"Процесс «{target}» не найден")
    killed, errors = [], []
    for p in victims:
        try:
            if p.pid in (0, 4, me) or (p.name() or "").lower() in PROTECTED_NAMES:
                errors.append(f"{p.name()} ({p.pid}) — системный, пропущен")
                continue
            name = p.name()
            p.terminate()
            try:
                p.wait(timeout=3)
            except psutil.TimeoutExpired:
                p.kill()
            killed.append(f"{name} ({p.pid})")
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            errors.append(f"{p.pid} — нет прав")
    msg = ""
    if killed:
        msg += "Завершено: " + ", ".join(killed)
    if errors:
        msg += ("\n" if msg else "") + "Не удалось: " + ", ".join(errors)
    if not killed:
        raise RuntimeError(msg or "Ничего не завершено")
    return msg
