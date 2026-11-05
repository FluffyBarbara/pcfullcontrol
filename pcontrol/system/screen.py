"""Скриншоты экрана и фото с веб-камеры."""
from __future__ import annotations

import io


def _mss():
    import mss  # type: ignore
    return mss.MSS() if hasattr(mss, "MSS") else mss.mss()


def screenshot(monitor: int = 0, quality: int = 75, max_width: int = 2560) -> bytes:
    """Скриншот в JPEG. monitor=0 — все мониторы, 1..N — конкретный монитор."""
    from PIL import Image

    img = None
    try:
        with _mss() as sct:
            mons = sct.monitors
            idx = monitor if 0 <= monitor < len(mons) else 0
            shot = sct.grab(mons[idx])
            img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    except Exception as first_error:
        try:
            from PIL import ImageGrab
            img = ImageGrab.grab(all_screens=True)
        except Exception:
            raise RuntimeError(
                f"Не удалось сделать скриншот ({first_error}). "
                "Агент должен быть запущен в сеансе пользователя с рабочим столом."
            )
    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def monitor_count() -> int:
    try:
        with _mss() as sct:
            return len(sct.monitors) - 1
    except Exception:
        return 1


def webcam_photo(camera: int = 0) -> bytes:
    try:
        import cv2  # type: ignore
    except ImportError:
        raise RuntimeError("Для фото с веб-камеры установите: pip install opencv-python")
    cap = cv2.VideoCapture(camera)
    try:
        if not cap.isOpened():
            raise RuntimeError("Веб-камера не найдена или занята")
        frame = None
        for _ in range(10):  # первые кадры часто тёмные — даём камере настроиться
            ok, frame = cap.read()
        if frame is None:
            raise RuntimeError("Не удалось получить кадр с камеры")
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
        if not ok:
            raise RuntimeError("Ошибка кодирования изображения")
        return buf.tobytes()
    finally:
        cap.release()
