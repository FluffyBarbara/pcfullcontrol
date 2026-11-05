"""Пароль и сессии веб-панели (хранятся локально в SQLite, пароль — только хеш PBKDF2)."""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from .db import Database

ITERATIONS = 240_000


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return f"pbkdf2_sha256${ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, AttributeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_password() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(12))


class LoginBlocked(Exception):
    pass


class WebAuth:
    def __init__(self, db: Database, session_days: int = 30, max_attempts: int = 5, lockout_minutes: int = 15):
        self.db = db
        self.session_days = session_days
        self.max_attempts = max_attempts
        self.lockout_minutes = lockout_minutes

    def has_password(self) -> bool:
        return bool(self.db.get_setting("web_password_hash"))

    def ensure_password(self) -> str | None:
        """Если пароль не задан — создать случайный и вернуть его (иначе None)."""
        if self.has_password():
            return None
        pwd = generate_password()
        self.set_password(pwd)
        return pwd

    def set_password(self, password: str) -> None:
        if len(password) < 6:
            raise ValueError("Пароль должен быть не короче 6 символов")
        self.db.set_setting("web_password_hash", hash_password(password))
        self.db.delete_all_sessions()

    def check_password(self, password: str) -> bool:
        stored = self.db.get_setting("web_password_hash")
        return bool(stored) and verify_password(password, stored)

    def is_blocked(self, ip: str) -> bool:
        since = time.time() - self.lockout_minutes * 60
        return self.db.count_login_attempts(ip, since) >= self.max_attempts

    def login(self, password: str, ip: str, user_agent: str = "") -> str:
        """Вернуть токен сессии. Бросает LoginBlocked или ValueError."""
        if self.is_blocked(ip):
            raise LoginBlocked(f"Слишком много попыток. Повторите через {self.lockout_minutes} мин.")
        if not self.check_password(password):
            self.db.add_login_attempt(ip)
            raise ValueError("Неверный пароль")
        self.db.clear_login_attempts(ip)
        token = secrets.token_urlsafe(32)
        self.db.add_session(_token_hash(token), time.time() + self.session_days * 86400, ip, user_agent)
        return token

    def validate(self, token: str | None) -> bool:
        if not token:
            return False
        th = _token_hash(token)
        s = self.db.get_session(th)
        if not s or s["expires"] < time.time():
            return False
        if time.time() - (s["last_seen"] or 0) > 60:
            self.db.touch_session(th)
        return True

    def logout(self, token: str) -> None:
        self.db.delete_session(_token_hash(token))

    def logout_all(self) -> int:
        return self.db.delete_all_sessions()
