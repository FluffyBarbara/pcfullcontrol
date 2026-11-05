"""Простой файловый менеджер: просмотр папок, скачивание и загрузка файлов."""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

import psutil

from ..platform_utils import IS_WINDOWS

TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024


class FileAccessError(Exception):
    pass


class FileManager:
    def __init__(self, allowed_roots: list[str], upload_dir: Path):
        self.allowed_roots = [Path(r).expanduser().resolve() for r in allowed_roots if r]
        self.upload_dir = upload_dir

    def check(self, path: str | Path) -> Path:
        p = Path(path).expanduser()
        try:
            p = p.resolve()
        except OSError as e:
            raise FileAccessError(f"Неверный путь: {e}")
        if self.allowed_roots and not any(p == r or r in p.parents for r in self.allowed_roots):
            raise FileAccessError("Доступ к этой папке запрещён настройками (files.allowed_roots)")
        return p

    def roots(self) -> list[dict]:
        """Стартовые точки: разрешённые папки или диски + домашняя папка."""
        if self.allowed_roots:
            paths = self.allowed_roots
        else:
            paths = [Path.home()]
            seen = set()
            for part in psutil.disk_partitions(all=False):
                if "cdrom" in part.opts or not part.fstype:
                    continue
                if part.mountpoint.startswith(("/snap", "/boot", "/var/lib")):
                    continue
                if part.mountpoint not in seen:
                    seen.add(part.mountpoint)
                    paths.append(Path(part.mountpoint))
            for extra in ("Desktop", "Downloads", "Documents"):
                d = Path.home() / extra
                if d.exists():
                    paths.insert(1, d)
        return [{"name": str(p), "path": str(p), "is_dir": True, "size": None, "mtime": None}
                for p in paths]

    def list_dir(self, path: str) -> list[dict]:
        p = self.check(path)
        if not p.is_dir():
            raise FileAccessError("Это не папка")
        items = []
        try:
            with os.scandir(p) as it:
                for entry in it:
                    try:
                        is_dir = entry.is_dir()
                        st = entry.stat() if not is_dir else None
                        items.append({
                            "name": entry.name,
                            "path": str(Path(entry.path)),
                            "is_dir": is_dir,
                            "size": st.st_size if st else None,
                            "mtime": st.st_mtime if st else None,
                        })
                    except OSError:
                        continue
        except PermissionError:
            raise FileAccessError("Нет прав на чтение этой папки")
        items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        return items

    def parent(self, path: str) -> str | None:
        p = self.check(path)
        if p.parent == p:
            return None
        if self.allowed_roots and p in self.allowed_roots:
            return None
        return str(p.parent)

    def file_for_download(self, path: str) -> Path:
        p = self.check(path)
        if not p.is_file():
            raise FileAccessError("Файл не найден")
        return p

    def upload_target(self, filename: str, directory: str | None = None) -> Path:
        """Путь для сохранения нового файла (без перезаписи существующих)."""
        target_dir = self.check(directory) if directory else self.upload_dir
        target_dir.mkdir(parents=True, exist_ok=True)
        name = safe_filename(filename) or f"file_{int(time.time())}"
        target = target_dir / name
        if target.exists():
            target = target_dir / f"{target.stem}_{int(time.time())}{target.suffix}"
        return target

    def save_upload(self, filename: str, data: bytes, directory: str | None = None) -> Path:
        target = self.upload_target(filename, directory)
        target.write_bytes(data)
        return target

    def delete(self, path: str) -> str:
        p = self.check(path)
        if p.is_dir():
            raise FileAccessError("Удаление папок отключено для безопасности")
        p.unlink()
        return f"Удалён файл {p}"


def safe_filename(name: str) -> str:
    name = os.path.basename(name or "")
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    if IS_WINDOWS and name.upper().split(".")[0] in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT1"}:
        name = "_" + name
    return name[:200]
