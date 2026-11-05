"""Долгие фоновые задания (обновления и т.п.) с сохранением результата в базе."""
from __future__ import annotations

import html
import logging
import threading
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from .core import AppContext

log = logging.getLogger(__name__)


class JobManager:
    def __init__(self, ctx: "AppContext"):
        self.ctx = ctx
        self._lock = threading.Lock()
        ctx.db.fail_stale_jobs()

    def start(self, kind: str, title: str, func: Callable[[], str], notify: bool = True) -> tuple[int, bool]:
        """Запустить задание. Возвращает (id, запущено_новое). Одновременно — одно задание каждого вида."""
        with self._lock:
            existing = self.ctx.db.running_job(kind)
            if existing:
                return existing["id"], False
            job_id = self.ctx.db.create_job(kind, title)

        def runner():
            try:
                output = func() or ""
                status = "done"
            except Exception as e:
                log.exception("Задание %s завершилось с ошибкой", kind)
                output, status = f"Ошибка: {e}", "error"
            self.ctx.db.finish_job(job_id, status, output)
            if notify:
                icon = "✅" if status == "done" else "❌"
                head = f"{icon} <b>{html.escape(title)}</b> — задание #{job_id} завершено"
                text = output.strip() or "(нет вывода)"
                if len(text) <= 3000:
                    self.ctx.notifier.notify(f"{head}\n<pre>{html.escape(text)}</pre>", category="job")
                else:
                    self.ctx.notifier.notify(
                        head + "\nПолный вывод — в файле.", category="job",
                        document=(f"job_{job_id}_{kind}.txt", text.encode("utf-8")),
                    )

        threading.Thread(target=runner, name=f"job-{kind}", daemon=True).start()
        return job_id, True
