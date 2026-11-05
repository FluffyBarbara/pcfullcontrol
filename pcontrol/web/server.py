"""HTTP API и веб-панель (FastAPI)."""
from __future__ import annotations

import html
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..auth import LoginBlocked
from ..platform_utils import IS_WINDOWS
from ..scheduler import parse_time
from ..system import info, processes, screen
from ..system.files import FileAccessError
from ..system.media import get_volume

if TYPE_CHECKING:
    from ..core import AppContext

STATIC_DIR = Path(__file__).parent / "static"
MAX_UPLOAD = 2 * 1024 * 1024 * 1024  # 2 ГБ


class LoginBody(BaseModel):
    password: str


class ActionBody(BaseModel):
    arg: str = ""


class PasswordBody(BaseModel):
    old: str
    new: str


class PathBody(BaseModel):
    path: str


class MuteBody(BaseModel):
    muted: bool


class TaskBody(BaseModel):
    action: str
    arg: str = ""
    kind: str                      # in | at | daily
    delay_minutes: float | None = None
    run_at: str | None = None      # "YYYY-MM-DDTHH:MM" (локальное время)
    time_of_day: str | None = None # "HH:MM"
    weekdays: list[int] | None = None


def create_app(ctx: "AppContext") -> FastAPI:
    app = FastAPI(title="PC Control", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    auth = ctx.web_auth

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'"
        )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def client_ip(request: Request) -> str:
        return request.client.host if request.client else "?"

    def require_auth(request: Request) -> str:
        header = request.headers.get("authorization", "")
        token = header[7:] if header.lower().startswith("bearer ") else ""
        if not auth.validate(token):
            raise HTTPException(401, "Требуется вход")
        return token

    # ---------------- статика ----------------
    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/manifest.webmanifest", include_in_schema=False)
    def manifest():
        return FileResponse(STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # ---------------- вход ----------------
    @app.post("/api/login")
    def login(body: LoginBody, request: Request):
        ip = client_ip(request)
        ua = request.headers.get("user-agent", "")
        try:
            token = auth.login(body.password, ip, ua)
        except LoginBlocked as e:
            raise HTTPException(429, str(e))
        except ValueError as e:
            if auth.is_blocked(ip):
                ctx.notifier.notify(
                    f"🚨 <b>Подбор пароля к веб-панели</b>\nIP {html.escape(ip)} заблокирован на "
                    f"{auth.lockout_minutes} мин после {auth.max_attempts} неудачных попыток.",
                    category="security", level="critical")
            raise HTTPException(401, str(e))
        ctx.notifier.notify(f"🔓 Вход в веб-панель с IP {html.escape(ip)}\n<i>{html.escape(ua[:120])}</i>",
                            category="security", level="warning")
        return {"token": token}

    @app.post("/api/logout")
    def logout(token: str = Depends(require_auth)):
        auth.logout(token)
        return {"ok": True}

    # ---------------- информация ----------------
    @app.get("/api/info")
    def get_info(_: str = Depends(require_auth)):
        return {
            "pc_name": ctx.pc_name,
            "version": __version__,
            "os": info.os_description(),
            "is_windows": IS_WINDOWS,
            "allow_shell": bool(ctx.config["security"]["allow_shell"]),
            "apps": list(ctx.config["apps"].keys()),
            "actions": [a.to_dict() for a in ctx.actions.available()],
            "telegram": {
                "enabled": ctx.tg is not None,
                "bot": getattr(ctx.bot, "username", "") if ctx.bot else "",
                "users": len(ctx.authorized_ids()),
                "pair_code": ctx.pairing_code() if ctx.tg else "",
            },
            "monitors": screen.monitor_count(),
            "upload_dir": str(ctx.config.upload_dir),
        }

    @app.get("/api/status")
    def status(_: str = Depends(require_auth)):
        s = info.get_status(cpu_interval=0.3)
        s["volume"] = get_volume()
        s["notifications_muted"] = ctx.notifier.muted
        s["agent_uptime"] = time.time() - ctx.started_at
        return s

    @app.get("/api/metrics")
    def metrics(hours: float = 1, _: str = Depends(require_auth)):
        hours = max(0.1, min(hours, 24 * 7))
        rows = ctx.db.metrics_since(time.time() - hours * 3600)
        step = max(1, len(rows) // 300)
        return [{"ts": r["ts"], "cpu": r["cpu"], "ram": r["ram"], "temp": r["temp"]} for r in rows[::step]]

    # ---------------- действия ----------------
    @app.post("/api/action/{name}")
    def run_action(name: str, body: ActionBody, _: str = Depends(require_auth)):
        if not ctx.actions.get(name):
            raise HTTPException(404, "Неизвестное действие")
        ok, result = ctx.actions.run(name, body.arg, source="web", user="web")
        return {"ok": ok, "result": result}

    @app.post("/api/apps/{index}")
    def launch_app(index: int, _: str = Depends(require_auth)):
        apps = list(ctx.config["apps"].values())
        if not 0 <= index < len(apps):
            raise HTTPException(404, "Программа не найдена")
        ok, result = ctx.actions.run("launch", str(apps[index]), source="web", user="web")
        return {"ok": ok, "result": result}

    @app.get("/api/processes")
    def get_processes(sort: str = "cpu", q: str = "", limit: int = 100, _: str = Depends(require_auth)):
        return processes.list_processes(sort=sort, limit=max(1, min(limit, 500)), query=q)

    @app.get("/api/screenshot")
    def get_screenshot(monitor: int = 0, quality: int = 70, _: str = Depends(require_auth)):
        try:
            img = screen.screenshot(monitor=monitor, quality=max(10, min(quality, 95)))
        except Exception as e:
            raise HTTPException(500, str(e))
        return Response(img, media_type="image/jpeg")

    @app.get("/api/webcam")
    def get_webcam(_: str = Depends(require_auth)):
        try:
            img = screen.webcam_photo()
        except Exception as e:
            raise HTTPException(500, str(e))
        ctx.db.log_command("web", "web", "webcam", "", True, "фото")
        return Response(img, media_type="image/jpeg")

    # ---------------- файлы ----------------
    @app.get("/api/files")
    def list_files(path: str = "", _: str = Depends(require_auth)):
        try:
            if not path:
                return {"path": "", "parent": None, "entries": ctx.files.roots()}
            entries = ctx.files.list_dir(path)
            resolved = str(ctx.files.check(path))
            parent = ctx.files.parent(path)
            return {"path": resolved, "parent": parent if parent is not None else "", "entries": entries}
        except FileAccessError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/files/download")
    def download(path: str, _: str = Depends(require_auth)):
        try:
            p = ctx.files.file_for_download(path)
        except FileAccessError as e:
            raise HTTPException(400, str(e))
        ctx.db.log_command("web", "web", "download", str(p), True, "")
        return FileResponse(p, filename=p.name, media_type="application/octet-stream")

    @app.post("/api/files/upload")
    async def upload(file: UploadFile = File(...), directory: str = Form(""),
                     _: str = Depends(require_auth)):
        try:
            saved = ctx.files.upload_target(file.filename or "file", directory or None)
        except (FileAccessError, OSError) as e:
            raise HTTPException(400, str(e))
        size = 0
        try:
            with open(saved, "wb") as out:
                while chunk := await file.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise HTTPException(413, "Файл слишком большой (максимум 2 ГБ)")
                    out.write(chunk)
        except BaseException:
            saved.unlink(missing_ok=True)
            raise
        ctx.db.log_command("web", "web", "upload", str(saved), True, info.fmt_bytes(size))
        ctx.notifier.notify(f"📥 Через веб-панель загружен файл:\n<code>{html.escape(str(saved))}</code>",
                            category="files")
        return {"ok": True, "path": str(saved)}

    @app.post("/api/files/delete")
    def delete_file(body: PathBody, _: str = Depends(require_auth)):
        try:
            msg = ctx.files.delete(body.path)
        except (FileAccessError, OSError) as e:
            raise HTTPException(400, str(e))
        ctx.db.log_command("web", "web", "delete", body.path, True, msg)
        return {"ok": True, "result": msg}

    # ---------------- планировщик ----------------
    @app.get("/api/tasks")
    def list_tasks(_: str = Depends(require_auth)):
        return [{**t, "description": ctx.scheduler.describe(t)} for t in ctx.db.list_tasks()]

    @app.post("/api/tasks")
    def add_task(body: TaskBody, _: str = Depends(require_auth)):
        sch = ctx.scheduler
        try:
            if body.kind == "in":
                if not body.delay_minutes or body.delay_minutes <= 0:
                    raise ValueError("Укажите, через сколько минут")
                tid = sch.add_once(body.action, body.arg, time.time() + body.delay_minutes * 60)
            elif body.kind == "at":
                if not body.run_at:
                    raise ValueError("Укажите дату и время")
                ts = datetime.fromisoformat(body.run_at).timestamp()
                if ts <= time.time():
                    raise ValueError("Время уже прошло")
                tid = sch.add_once(body.action, body.arg, ts)
            elif body.kind == "daily":
                parse_time(body.time_of_day or "")
                days = [d for d in (body.weekdays or []) if 0 <= d <= 6] or list(range(7))
                tid = sch.add_daily(body.action, body.arg, body.time_of_day, days)
            else:
                raise ValueError("Неизвестный тип задачи")
            act = ctx.actions.get(body.action)
            if act and act.arg_required and not body.arg.strip():
                ctx.db.delete_task(tid)
                raise ValueError(f"Нужен параметр: {act.arg_hint}")
        except ValueError as e:
            raise HTTPException(400, str(e))
        task = ctx.db.get_task(tid)
        return {**task, "description": sch.describe(task)}

    @app.post("/api/tasks/{task_id}/toggle")
    def toggle_task(task_id: int, _: str = Depends(require_auth)):
        t = ctx.db.get_task(task_id)
        if not t:
            raise HTTPException(404, "Задача не найдена")
        ctx.db.set_task_enabled(task_id, not t["enabled"])
        return {"ok": True, "enabled": not t["enabled"]}

    @app.delete("/api/tasks/{task_id}")
    def delete_task(task_id: int, _: str = Depends(require_auth)):
        if not ctx.db.delete_task(task_id):
            raise HTTPException(404, "Задача не найдена")
        return {"ok": True}

    # ---------------- задания, журнал ----------------
    @app.get("/api/jobs")
    def jobs(_: str = Depends(require_auth)):
        return ctx.db.recent_jobs(15)

    @app.get("/api/jobs/{job_id}")
    def job(job_id: int, _: str = Depends(require_auth)):
        j = ctx.db.get_job(job_id)
        if not j:
            raise HTTPException(404, "Задание не найдено")
        return j

    @app.get("/api/events")
    def events(limit: int = 100, _: str = Depends(require_auth)):
        return ctx.db.recent_events(max(1, min(limit, 500)))

    @app.get("/api/commands")
    def commands(limit: int = 100, _: str = Depends(require_auth)):
        return ctx.db.recent_commands(max(1, min(limit, 500)))

    # ---------------- настройки ----------------
    @app.post("/api/password")
    def change_password(body: PasswordBody, _: str = Depends(require_auth)):
        if not auth.check_password(body.old):
            raise HTTPException(400, "Текущий пароль неверный")
        try:
            auth.set_password(body.new)
        except ValueError as e:
            raise HTTPException(400, str(e))
        ctx.notifier.notify("🔑 Пароль веб-панели изменён", category="security", level="warning")
        return {"ok": True}

    @app.get("/api/sessions")
    def sessions(_: str = Depends(require_auth)):
        return ctx.db.list_sessions()

    @app.post("/api/sessions/revoke_all")
    def revoke_all(_: str = Depends(require_auth)):
        return {"ok": True, "count": auth.logout_all()}

    @app.post("/api/notifications")
    def set_notifications(body: MuteBody, _: str = Depends(require_auth)):
        ctx.notifier.set_muted(body.muted)
        return {"ok": True, "muted": body.muted}

    @app.post("/api/pair_code/regenerate")
    def regen_pair(_: str = Depends(require_auth)):
        return {"pair_code": ctx.pairing_code(regenerate=True)}

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        return JSONResponse({"detail": f"Внутренняя ошибка: {exc}"}, status_code=500)

    return app
