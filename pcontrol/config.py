"""Загрузка настроек из config.yaml с значениями по умолчанию."""
from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = BASE_DIR / "config.yaml"

DEFAULTS: dict[str, Any] = {
    "pc_name": "",
    "data_dir": "data",
    "telegram": {
        "enabled": True,
        "token": "",
        "allowed_user_ids": [],
        "confirm_dangerous": True,
        "notify_web_actions": True,
        "proxy": "",
    },
    "web": {
        "enabled": True,
        "host": "0.0.0.0",
        "port": 8765,
        "session_days": 30,
    },
    "security": {
        "allow_shell": False,
        "max_login_attempts": 5,
        "lockout_minutes": 15,
    },
    "files": {
        "allowed_roots": [],
        "upload_dir": "",
    },
    "apps": {},
    "monitor": {
        "interval_seconds": 30,
        "metrics_retention_days": 7,
        "cpu_percent": 90,
        "cpu_checks": 4,
        "ram_percent": 90,
        "disk_free_percent": 10,
        "temp_celsius": 85,
        "battery_low_percent": 20,
        "alert_cooldown_minutes": 30,
        "notify_on_start": True,
        "notify_on_login": True,
        "notify_ip_change": True,
        "notify_power_source": True,
        "watch_processes": [],
    },
    "updates": {
        "daily_check_time": "12:00",
    },
}


def deep_merge(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = deep_merge(result[key], value)
        else:
            result[key] = value
    return result


class Config(dict):
    """Словарь настроек с удобными вспомогательными свойствами."""

    path: Path | None = None

    @property
    def data_dir(self) -> Path:
        p = Path(self["data_dir"]).expanduser()
        if not p.is_absolute():
            p = BASE_DIR / p
        return p

    @property
    def upload_dir(self) -> Path:
        raw = self["files"].get("upload_dir") or ""
        if raw:
            return Path(raw).expanduser()
        return Path.home() / "Downloads" / "PCControl"


def load_config(path: str | os.PathLike | None = None) -> Config:
    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    user_cfg: dict = {}
    if cfg_path.exists():
        with open(cfg_path, "r", encoding="utf-8") as f:
            user_cfg = yaml.safe_load(f) or {}
    merged = deep_merge(DEFAULTS, user_cfg)

    # Переменные окружения имеют приоритет (удобно для Docker/служб)
    if os.environ.get("PCC_TELEGRAM_TOKEN"):
        merged["telegram"]["token"] = os.environ["PCC_TELEGRAM_TOKEN"]
    if os.environ.get("PCC_WEB_PORT"):
        merged["web"]["port"] = int(os.environ["PCC_WEB_PORT"])

    ids = merged["telegram"].get("allowed_user_ids") or []
    merged["telegram"]["allowed_user_ids"] = [int(i) for i in ids]
    merged["apps"] = merged.get("apps") or {}

    cfg = Config(merged)
    cfg.path = cfg_path
    return cfg
