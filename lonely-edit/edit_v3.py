#!/usr/bin/env python3
"""
FLUFFY BARBARA — «НЕ ИЩИ МЕНЯ» · cinematic TikTok edit, v3.

60 fps, 1080x1920. Плавные бит-синхронные переходы (zoom-blur, whip, spin,
flash, light-leak, glitch), 3D-телефон, свечение/халация/зерно, плавные титры.

  python3 edit_v3.py --track track.mp3 --start 40 --dur 12

Анализ битов/аудио берётся из make_edit.py.
"""
import argparse
import math
import multiprocessing as mp
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import make_edit as me

# ───────────────────────────── config ─────────────────────────────
SW, SH = 720, 1280            # сцены рисуются здесь
W, H = 1080, 1920             # финальный кадр (титры и пост — здесь)
FPS = 60
DUR = 12.0
SR = me.SR
DROP_BEAT = 4
RED = (232, 22, 38)
FONT_BIG = me.FONT_BIG
FONT_UI = me.FONT_UI
FONT_UI_REG = me.FONT_UI_REG
FONT_MONO = me.FONT_MONO
FONT_IT = "/usr/share/fonts/opentype/inter/Inter-SemiBoldItalic.otf"

me.osd = lambda *a, **k: None   # убираем VHS-OSD со старых сцен — теперь чище


# ───────────────────────────── easing ─────────────────────────────
def cl(x, a=0.0, b=1.0):
    return a if x < a else b if x > b else x


def e_out(p):
    p = cl(p)
    return 1 - (1 - p) ** 3


def e_in(p):
    p = cl(p)
    return p ** 3


def e_io(p):
    p = cl(p)
    return 4 * p ** 3 if p < 0.5 else 1 - (-2 * p + 2) ** 3 / 2


def e_back(p, s=1.6):
    p = cl(p) - 1
    return 1 + (s + 1) * p ** 3 + s * p ** 2


def lerp(a, b, p):
    return a + (b - a) * p


def font(path, size):
    return me.font(path, size)


# ───────────────────────────── geometry ─────────────────────────────
def persp_coeffs(dst, src):
    A, B = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); B.append(v)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()


def project_quad(w, h, rx, ry, rz, cx, cy, scale, f=1500.0):
    rx, ry, rz = map(math.radians, (rx, ry, rz))
    pts = np.array([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]]) * scale
    Rx = np.array([[1, 0, 0], [0, math.cos(rx), -math.sin(rx)], [0, math.sin(rx), math.cos(rx)]])
    Ry = np.array([[math.cos(ry), 0, math.sin(ry)], [0, 1, 0], [-math.sin(ry), 0, math.cos(ry)]])
    Rz = np.array([[math.cos(rz), -math.sin(rz), 0], [math.sin(rz), math.cos(rz), 0], [0, 0, 1]])
    p = pts @ (Rz @ Ry @ Rx).T
    z = p[:, 2] + f
    return [(cx + f * p[i, 0] / z[i], cy + f * p[i, 1] / z[i]) for i in range(4)]


def camera(img, z=1.0, rot=0.0, fx=None, fy=None, ox=0.0, oy=0.0):
    """Камера: зум z вокруг точки (fx,fy) сцены, поворот rot°, сдвиг (ox,oy) в px кадра."""
    fx = SW / 2 if fx is None else fx
    fy = SH / 2 if fy is None else fy
    if abs(z - 1) < 1e-4 and abs(rot) < 1e-3 and fx == SW / 2 and fy == SH / 2 and ox == 0 and oy == 0:
        return img
    a = math.radians(rot)
    c, s = math.cos(a) / z, math.sin(a) / z
    cx, cy = SW / 2 + ox, SH / 2 + oy
    # input = focus + R^-1/z · (out − c)
    data = (c, s, fx - c * cx - s * cy, -s, c, fy + s * cx - c * cy)
    return img.transform((SW, SH), Image.AFFINE, data, Image.BICUBIC, fillcolor=(0, 0, 0))


# ───────────────────────────── assets ─────────────────────────────
def bokeh_field(w, h, n, seed, palette, rmin, rmax, blur, bg=(6, 6, 9), ymax=1.0):
    rng = np.random.default_rng(seed)
    im = Image.new("RGB", (w, h), bg)
    lay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for _ in range(n):
        x, y = rng.uniform(0, w), rng.uniform(0, h * ymax)
        r = rng.uniform(rmin, rmax)
        col = palette[rng.integers(len(palette))]
        a = int(rng.uniform(40, 150))
        d.ellipse([x - r, y - r, x + r, y + r], fill=col + (a,))
        d.ellipse([x - r * 0.8, y - r * 0.8, x + r * 0.8, y + r * 0.8], fill=col + (int(a * 0.5),))
    lay = lay.filter(ImageFilter.GaussianBlur(blur))
    im.paste(lay, (0, 0), lay)
    return im


class Assets3:
    def __init__(self):
        self.old = me.Assets()
        rng = np.random.default_rng(5)
        warm, white, red, blue = (255, 170, 80), (225, 230, 255), (255, 40, 55), (90, 130, 255)
        self.room = bokeh_field(SW + 120, SH + 120, 38, 3, [blue, red, warm, blue], 30, 110, 26, bg=(5, 5, 8))
        self.city = bokeh_field(SW + 160, SH + 160, 170, 9, [warm, warm, white, red, blue], 6, 44, 7,
                                bg=(4, 5, 9), ymax=1.0)
        # капли на стекле
        self.drops = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
        d = ImageDraw.Draw(self.drops)
        for _ in range(420):
            x, y, r = rng.uniform(0, SW), rng.uniform(0, SH), rng.uniform(2, 9)
            d.ellipse([x - r, y - r * 1.1, x + r, y + r * 1.1], fill=(200, 210, 230, 34), outline=(0, 0, 0, 50))
            d.ellipse([x - r * 0.45, y - r * 0.6, x - r * 0.05, y - r * 0.2], fill=(255, 255, 255, 120))
        self.slides = np.stack([rng.uniform(20, SW - 20, 18), rng.uniform(-SH, SH, 18),
                                rng.uniform(60, 240, 18), rng.uniform(5, 11, 18), rng.uniform(0, 6, 18)], 1)
        self._phone_static()
        self._polaroid()
        self._map()
        g = [np.random.default_rng(100 + k).normal(0, 1, (H // 2, W // 2)).astype(np.float32) for k in range(8)]
        self.grain = [np.asarray(Image.fromarray(np.clip(x * 40 + 128, 0, 255).astype(np.uint8))
                                 .resize((W, H), Image.BILINEAR), np.float32)[..., None] / 255 - 0.5 for x in g]
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        r2 = ((xx - W / 2) / (W * 0.7)) ** 2 + ((yy - H / 2) / (H * 0.7)) ** 2
        self.vig = np.clip(1.12 - 0.6 * r2, 0.35, 1)[..., None].astype(np.float32)

    # ── телефон
    def _phone_static(self):
        bez = 24
        self.bez = bez
        pw, ph = SW + 2 * bez, SH + 2 * bez
        body = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
        d = ImageDraw.Draw(body)
        d.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=118, fill=(22, 22, 26, 255))
        d.rounded_rectangle([2, 2, pw - 3, ph - 3], radius=116, outline=(120, 120, 130, 255), width=3)
        d.rounded_rectangle([7, 7, pw - 8, ph - 8], radius=112, outline=(40, 40, 46, 255), width=4)
        self.phone_body = body
        m = Image.new("L", (SW, SH), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, SW - 1, SH - 1], radius=96, fill=255)
        self.screen_mask = m
        gl = np.zeros((SH, SW), np.float32)
        yy, xx = np.mgrid[0:SH, 0:SW]
        gl += np.clip(1 - np.abs((xx * 0.9 + yy * 0.45) - 520) / 260, 0, 1) * 16
        self.glare = Image.fromarray(np.dstack([np.full((SH, SW, 3), 255, np.uint8), gl.astype(np.uint8)]), "RGBA")

    def phone(self, ui):
        ph = self.phone_body.copy()
        scr = ui.convert("RGBA")
        scr.alpha_composite(self.glare)
        ph.paste(scr, (self.bez, self.bez), self.screen_mask)
        d = ImageDraw.Draw(ph)
        cx = self.bez + SW / 2
        d.rounded_rectangle([cx - 78, self.bez + 20, cx + 78, self.bez + 66], radius=23, fill=(0, 0, 0, 255))
        return ph

    # ── полароид
    def _polaroid(self):
        cw, chh = 480, 580
        card = Image.new("RGBA", (cw, chh), (238, 235, 228, 255))
        photo = Image.new("RGB", (430, 430), (0, 0, 0))
        f = np.zeros((430, 430, 3), np.float32)
        yy, xx = np.mgrid[0:430, 0:430].astype(np.float32)
        f += (np.array([0.05, 0.07, 0.14]) * (1 - yy / 430)[..., None])
        glow = np.exp(-(((xx - 215) / 70) ** 2 + ((yy - 90) / 50) ** 2))
        cone = np.clip(1 - np.abs(xx - 215) / (20 + (yy - 90).clip(0) * 0.6), 0, 1) * (yy > 90) * 0.55
        f += (glow[..., None] * 1.4 + cone[..., None]) * np.array([1.0, 0.75, 0.45])
        photo = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
        d = ImageDraw.Draw(photo)
        d.rectangle([0, 395, 430, 430], fill=(12, 10, 10))
        d.line([(300, 70), (300, 400)], fill=(15, 15, 18), width=8)
        d.line([(300, 74), (230, 74)], fill=(15, 15, 18), width=6)
        for cx, h_, hair in ((178, 1.0, True), (252, 1.12, False)):     # двое держатся за руки
            top = 400 - 190 * h_
            d.ellipse([cx - 19, top, cx + 19, top + 40], fill=(8, 8, 10))
            if hair:
                d.polygon([(cx - 22, top + 14), (cx + 22, top + 14), (cx + 26, top + 70), (cx - 26, top + 70)], fill=(8, 8, 10))
            d.polygon([(cx - 26, top + 40), (cx + 26, top + 40), (cx + 30, top + 120), (cx + 18, 400),
                       (cx - 18, 400), (cx - 30, top + 120)], fill=(8, 8, 10))
        d.line([(205, 300), (225, 300)], fill=(8, 8, 10), width=10)
        photo = photo.filter(ImageFilter.GaussianBlur(0.8))
        card.paste(photo, (25, 25))
        cd = ImageDraw.Draw(card)
        cd.text((40, 500), "мы. 03:07", font=font(FONT_IT, 34), fill=(60, 60, 70))
        # рваный край
        rng = np.random.default_rng(4)
        xs = 236 + np.cumsum(rng.normal(0, 3.2, chh))
        xs = 236 + (xs - xs.mean()) * 0.8
        al = np.asarray(card.split()[3]).copy()
        left = np.arange(cw)[None, :] < xs[:, None]
        edge = np.abs(np.arange(cw)[None, :] - xs[:, None]) < 3
        L, R = card.copy(), card.copy()
        la, ra = al * left, al * (~left)
        arr = np.asarray(card).copy()
        arr[edge] = [250, 248, 244, 255]
        base = Image.fromarray(arr, "RGBA")
        L, R = base.copy(), base.copy()
        L.putalpha(Image.fromarray(la.astype(np.uint8)))
        R.putalpha(Image.fromarray(ra.astype(np.uint8)))
        self.pol_full, self.pol_L, self.pol_R = card, L, R

    # ── карта
    def _map(self):
        S = 1700
        rng = np.random.default_rng(21)
        im = Image.new("RGB", (S, S), (13, 15, 19))
        d = ImageDraw.Draw(im)
        for _ in range(260):
            x, y = rng.uniform(0, S), rng.uniform(0, S)
            w_, h_ = rng.uniform(40, 140), rng.uniform(40, 140)
            c = int(rng.uniform(16, 22))
            d.rectangle([x, y, x + w_, y + h_], fill=(c, c + 2, c + 5))
        for _ in range(14):
            x, y = rng.uniform(0, S), rng.uniform(0, S)
            d.ellipse([x, y, x + rng.uniform(80, 220), y + rng.uniform(80, 200)], fill=(15, 24, 19))
        pts = [(x, 900 + 260 * math.sin(x / 260) + 80 * math.sin(x / 90)) for x in range(-20, S + 40, 20)]
        d.line(pts, fill=(14, 22, 38), width=56)
        for k in range(0, S, 58):
            j = rng.normal(0, 6)
            d.line([(k + j, 0), (k - j, S)], fill=(30, 33, 40), width=3)
            d.line([(0, k + j), (S, k - j)], fill=(30, 33, 40), width=3)
        for _ in range(7):
            p0 = rng.uniform(0, S, 2)
            ang = rng.uniform(0, math.pi)
            line = [tuple(p0 + np.array([math.cos(ang), math.sin(ang)]) * s + 60 * math.sin(s / 300))
                    for s in range(-1800, 1800, 40)]
            d.line(line, fill=(52, 56, 66), width=9)
        for txt, x, y in (("ЦЕНТР", 520, 980), ("ЗАРЕЧЬЕ", 1100, 640), ("ВОКЗАЛ", 300, 1300),
                          ("ТРАССА М-4", 980, 380), ("ПРОМЗОНА", 1250, 1180), ("ЮГ", 700, 1500)):
            d.text((x, y), txt, font=font(FONT_UI, 26), fill=(78, 82, 94))
        self.map = im
        # маршрут — гладкий сплайн через опорные точки
        ctrl = np.array([(260, 1560), (420, 1300), (640, 1150), (760, 900), (980, 760), (1180, 520), (1420, 260)], float)
        tt = np.linspace(0, len(ctrl) - 1, 500)
        route = []
        for u in tt:
            i = min(int(u), len(ctrl) - 2)
            s = u - i
            p0, p1, p2, p3 = ctrl[max(i - 1, 0)], ctrl[i], ctrl[i + 1], ctrl[min(i + 2, len(ctrl) - 1)]
            route.append(0.5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s
                                + (-p0 + 3 * p1 - 3 * p2 + p3) * s ** 3))
        self.route = np.array(route)


A = None  # создаётся до fork


# ═════════════════════════════ UI экранов телефона ═════════════════════════════
def status_bar(d, dark=True):
    col = (240, 240, 240)
    d.text((70, 58), "3:07", font=font(FONT_UI, 30), fill=col, anchor="lm")
    d.rounded_rectangle([SW - 112, 46, SW - 62, 70], radius=7, outline=col, width=2)
    d.rounded_rectangle([SW - 108, 50, SW - 90, 66], radius=4, fill=RED)
    for k in range(4):
        d.rectangle([SW - 176 + k * 11, 66 - (k + 1) * 5, SW - 169 + k * 11, 68], fill=col if k < 1 else (90, 90, 95))


_bub = {}


def bubble_img(txt, time_s):
    k = (txt, time_s)
    if k in _bub:
        return _bub[k]
    f = font(FONT_UI_REG, 40)
    l, tp, r, bt = f.getbbox(txt)
    tw = r - l
    bw, bh = tw + 150, 84
    im = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, bw - 1, bh - 1], radius=36, fill=(38, 38, 43, 255))
    d.text((30, bh / 2), txt, font=f, fill=(244, 244, 246), anchor="lm")
    d.text((bw - 26, bh - 18), time_s, font=font(FONT_UI_REG, 20), fill=(130, 130, 138), anchor="rm")
    _bub[k] = im
    return im


def with_alpha(im, a):
    if a >= 0.999:
        return im
    im = im.copy()
    im.putalpha(im.getchannel("A").point(lambda v: int(v * a)))
    return im


CHAT = [("ты где?", 0.10), ("почему не отвечаешь", 0.45), ("ответь мне", 0.85), ("пожалуйста", 1.30)]


def ui_chat(t):
    img = Image.new("RGB", (SW, SH), (0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, SW, 250], fill=(16, 16, 19))
    status_bar(d)
    d.text((34, 172), "‹", font=font(FONT_UI, 60), fill=(80, 140, 255), anchor="lm")
    d.ellipse([84, 134, 164, 214], fill=(70, 30, 40))
    d.text((124, 174), "Л", font=font(FONT_UI, 38), fill=(255, 210, 215), anchor="mm")
    d.text((186, 154), "любимая", font=font(FONT_UI, 40), fill=(245, 245, 245), anchor="lm")
    typing = t >= 1.7
    d.text((186, 196), "печатает…" if typing and int(t * 3) % 4 != 3 else "в сети", font=font(FONT_UI_REG, 26),
           fill=(80, 140, 255), anchor="lm")
    d.line([(0, 250), (SW, 250)], fill=(30, 30, 34), width=2)
    d.text((SW / 2, 300), "Сегодня", font=font(FONT_UI_REG, 24), fill=(110, 110, 118), anchor="mm")
    y = 330
    for k, (txt, ta) in enumerate(CHAT):
        p = (t - ta) / 0.32
        if p <= 0:
            continue
        b = bubble_img(txt, f"03:0{4 + k}")
        a = e_out(p * 1.4)
        sc = lerp(0.86, 1.0, e_back(p))
        bi = b.resize((max(1, int(b.width * sc)), max(1, int(b.height * sc))), Image.BICUBIC) if sc < 0.999 else b
        dy = (1 - e_out(p)) * 46
        img.paste(with_alpha(bi, a), (36, int(y + dy + (b.height - bi.height) / 2)), with_alpha(bi, a))
        y += 96
    if typing:
        p = (t - 1.7) / 0.25
        a = e_out(p)
        lay = Image.new("RGBA", (150, 74), (0, 0, 0, 0))
        ld = ImageDraw.Draw(lay)
        ld.rounded_rectangle([0, 0, 149, 73], radius=36, fill=(38, 38, 43, 255))
        for k in range(3):
            h = 10 * max(0, math.sin(t * 9 - k * 0.9))
            c = int(140 + 100 * (h / 10))
            ld.ellipse([32 + k * 32, 28 - h, 52 + k * 32, 48 - h], fill=(c, c, c + 4, 255))
        lay = with_alpha(lay, a)
        img.paste(lay, (36, int(y + (1 - e_out(p)) * 30)), lay)
    d.rectangle([0, SH - 150, SW, SH], fill=(16, 16, 19))
    d.rounded_rectangle([36, SH - 128, SW - 120, SH - 62], radius=33, outline=(60, 60, 66), width=2)
    d.text((68, SH - 95), "Сообщение", font=font(FONT_UI_REG, 30), fill=(100, 100, 108), anchor="lm")
    d.ellipse([SW - 100, SH - 128, SW - 34, SH - 62], fill=(40, 40, 46))
    return img


def ui_call(t):
    img = Image.new("RGB", (SW, SH), (0, 0, 0))
    f = np.zeros((SH, SW, 3), np.float32)
    yy = np.linspace(0, 1, SH)[:, None, None]
    f += np.array([0.32, 0.05, 0.08]) * (1 - yy) ** 2 + np.array([0.03, 0.03, 0.05])
    img = Image.fromarray((f * 255).astype(np.uint8))
    d = ImageDraw.Draw(img, "RGBA")
    status_bar(d)
    d.text((SW / 2, 230), "любимая", font=font(FONT_BIG, 78), fill=(250, 250, 250), anchor="mm")
    d.text((SW / 2, 300), "мобильный", font=font(FONT_UI_REG, 30), fill=(210, 190, 195), anchor="mm")
    cy = 600
    for k in range(3):
        ph = ((t * 0.9) + k / 3) % 1
        r = 130 + ph * 170
        d.ellipse([SW / 2 - r, cy - r, SW / 2 + r, cy + r], outline=(255, 120, 130, int(110 * (1 - ph))), width=4)
    d.ellipse([SW / 2 - 130, cy - 130, SW / 2 + 130, cy + 130], fill=(90, 30, 42, 255))
    d.text((SW / 2, cy), "Л", font=font(FONT_BIG, 130), fill=(255, 215, 220), anchor="mm")
    for cx, col, lab in ((180, (235, 50, 60), "Отклонить"), (540, (52, 199, 89), "Ответить")):
        d.ellipse([cx - 72, 1010, cx + 72, 1154], fill=col + (255,))
        d.text((cx, 1192), lab, font=font(FONT_UI_REG, 26), fill=(220, 220, 225), anchor="mm")
    return img


def ui_missed(t):
    img = Image.new("RGB", (SW, SH), (0, 0, 0))
    d = ImageDraw.Draw(img)
    status_bar(d)
    d.text((40, 170), "Недавние", font=font(FONT_BIG, 64), fill=(245, 245, 245), anchor="lm")
    d.rounded_rectangle([40, 230, 520, 286], radius=14, fill=(30, 30, 34))
    d.rounded_rectangle([284, 234, 516, 282], radius=12, fill=(70, 70, 76))
    d.text((162, 258), "Все", font=font(FONT_UI, 26), fill=(230, 230, 230), anchor="mm")
    d.text((400, 258), "Пропущенные", font=font(FONT_UI, 26), fill=(245, 245, 245), anchor="mm")
    n = 23 + int(t * 4)
    off = (t * 46) % 98
    for k in range(-1, 11):
        y = 320 + k * 98 - off
        if y < 300:
            continue
        d.text((40, y + 34), f"любимая ({max(1, n - k)})", font=font(FONT_UI, 38), fill=(255, 69, 80), anchor="lm")
        d.text((40, y + 72), "мобильный", font=font(FONT_UI_REG, 24), fill=(120, 120, 128), anchor="lm")
        d.text((SW - 100, y + 50), f"03:{(9 - k) % 60:02d}", font=font(FONT_UI_REG, 28), fill=(120, 120, 128), anchor="rm")
        d.ellipse([SW - 76, y + 32, SW - 40, y + 68], outline=(80, 140, 255), width=3)
        d.line([(40, y + 97), (SW, y + 97)], fill=(32, 32, 36), width=2)
    d.rectangle([0, 0, SW, 296], fill=None)
    return img


def ui_unavail(lt):
    img = Image.new("RGB", (SW, SH), (6, 6, 8))
    d = ImageDraw.Draw(img, "RGBA")
    status_bar(d)
    d.text((SW / 2, 230), "он", font=font(FONT_BIG, 80), fill=(245, 245, 245), anchor="mm")
    a = e_out((lt - 0.12) / 0.3)
    d.text((SW / 2, 302), "вызов…" if lt < 0.12 else "вызов завершён", font=font(FONT_UI_REG, 30),
           fill=(150, 150, 158), anchor="mm")
    if a > 0:
        c = int(250 * a)
        d.text((SW / 2, 560 + 20 * (1 - a)), "Абонент временно", font=font(FONT_UI, 46), fill=(c, c, c), anchor="mm")
        d.text((SW / 2, 618 + 20 * (1 - a)), "недоступен", font=font(FONT_UI, 46), fill=(c, c, c), anchor="mm")
        g = int(140 * a)
        d.text((SW / 2, 680 + 20 * (1 - a)), "или находится вне зоны действия сети", font=font(FONT_UI_REG, 25),
               fill=(g, g, g + 6), anchor="mm")
    d.ellipse([SW / 2 - 72, 1010, SW / 2 + 72, 1154], fill=(235, 50, 60, 255))
    return img


# ═════════════════════════════ SCENES (720x1280) ═════════════════════════════
def scene_phone(ui, t, pose, shake=0.0):
    rx, ry, rz, sc, cx, cy = pose
    if shake:
        rz += math.sin(t * 70) * 2.2 * shake
        cx += math.sin(t * 83) * 6 * shake
    dx = 40 * math.sin(t * 0.3)
    bg = A.room.crop((60 + dx, 60, 60 + dx + SW, 60 + SH)).convert("RGBA")
    ph = A.phone(ui)
    pw, phh = ph.size
    quad = project_quad(pw, phh, rx, ry, rz, cx, cy, sc)
    co = persp_coeffs(quad, [(0, 0), (pw, 0), (pw, phh), (0, phh)])
    lay = ph.transform((SW, SH), Image.PERSPECTIVE, co, Image.BICUBIC)
    # тень + свет от экрана
    al = lay.getchannel("A").resize((SW // 8, SH // 8), Image.BILINEAR)
    sh = al.filter(ImageFilter.GaussianBlur(4)).resize((SW, SH), Image.BILINEAR)
    spill = al.filter(ImageFilter.GaussianBlur(9)).resize((SW, SH), Image.BILINEAR)
    m = np.asarray(ui.resize((8, 8), Image.BILINEAR), np.float32).mean((0, 1)) / 255
    col = np.clip(m * 2.2 + 0.08, 0, 1)
    f = np.asarray(bg, np.float32)[..., :3] / 255
    f *= 1 - np.asarray(sh, np.float32)[..., None] / 255 * 0.6
    f += np.asarray(spill, np.float32)[..., None] / 255 * col * 0.55
    bg = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
    bg.alpha_composite(lay)
    return bg.convert("RGB")


def scene_rain(t, lt):
    dx, dy = 80 + 60 * math.sin(t * 0.25), 80 + 30 * math.cos(t * 0.2)
    img = A.city.crop((dx, dy, dx + SW, dy + SH)).convert("RGBA")
    fog = Image.new("RGBA", (SW, SH), (120, 130, 150, 14))
    img.alpha_composite(fog)
    img.alpha_composite(A.drops)
    lay = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    for x, y0, v, r, ph in A.slides:
        prog = v * t + 40 * math.sin(t * 1.3 + ph)   # капля то стоит, то срывается
        y = (y0 + prog) % (SH + 200) - 100
        xx = x + 6 * math.sin(y / 60 + ph)
        d.line([(xx, y - 160), (xx, y)], fill=(210, 220, 240, 26), width=int(r * 0.7))
        d.ellipse([xx - r, y - r * 1.3, xx + r, y + r], fill=(210, 220, 240, 50), outline=(0, 0, 0, 70))
        d.ellipse([xx - r * 0.5, y - r * 0.9, xx - r * 0.05, y - r * 0.4], fill=(255, 255, 255, 170))
    img.alpha_composite(lay)
    return img.convert("RGB")


def scene_type(t, b):
    f = np.zeros((SH, SW, 3), np.float32)
    rows = A.old.rows
    rh = rows[0].shape[0]
    total = len(rows) * (rh + 8)
    y0 = (SH - total) // 2
    surge = (math.floor(b) + e_out(b - math.floor(b))) if b >= DROP_BEAT else b
    for r, strip in enumerate(rows):
        sw = strip.shape[1] // 4
        direction = 1 if r % 2 else -1
        off = int(t * (140 + 30 * r) * direction + surge * 70 * direction + r * 137) % sw
        row = np.roll(strip, -off, axis=1)[:, :SW]
        y = y0 + r * (rh + 8)
        h = min(row.shape[0], SH - y)
        if y >= 0 and h > 0:
            f[y:y + h] = row[:h]
    return Image.fromarray((f * 255).astype(np.uint8))


def scene_polaroid(t, lt):
    f = np.zeros((SH, SW, 3), np.float32)
    yy, xx = np.mgrid[0:SH, 0:SW].astype(np.float32)
    f += (np.exp(-(((xx - SW / 2) / 420) ** 2 + ((yy - SH * 0.4) / 520) ** 2)) * 0.22)[..., None] * np.array([1, 0.85, 0.7])
    f += 0.02
    bg = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8)).convert("RGBA")
    p = e_io((lt - 0.22) / 0.75)
    cx, cy = SW / 2, SH * 0.43
    pieces = [(A.pol_L, -1), (A.pol_R, 1)] if p > 0 else [(A.pol_full, 0)]
    for im, s in pieces:
        ang = -4 + s * 11 * p + 1.2 * math.sin(t * 1.1)
        rot = im.rotate(ang, Image.BICUBIC, expand=True)
        x = cx - rot.width / 2 + s * 95 * p
        y = cy - rot.height / 2 + 30 * p * p
        shadow = Image.new("RGBA", rot.size, (0, 0, 0, 0))
        shadow.putalpha(rot.getchannel("A").point(lambda v: int(v * 0.7)))
        shadow = shadow.filter(ImageFilter.GaussianBlur(14))
        bg.alpha_composite(shadow, (int(x + 14), int(y + 24)))
        bg.alpha_composite(rot, (int(x), int(y)))
    return bg.convert("RGB")


REG = ["77", "50", "36", "61", "23"]


def scene_map(t, lt):
    fr = e_io(lt / 1.25) * 0.92 + 0.04
    R = A.route
    k = int(fr * (len(R) - 1))
    hx, hy = R[k]
    j = min(k + 12, len(R) - 1)
    head = math.degrees(math.atan2(R[j][1] - R[max(k - 12, 0)][1], R[j][0] - R[max(k - 12, 0)][0]))
    C = 520
    crop = A.map.crop((int(hx - C), int(hy - C), int(hx + C), int(hy + C))).convert("RGBA")
    lay = Image.new("RGBA", crop.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    pts = [(x - hx + C, y - hy + C) for x, y in R[:k + 1]]
    if len(pts) > 1:
        d.line(pts, fill=(255, 40, 55, 120), width=26, joint="curve")
        glow = lay.filter(ImageFilter.GaussianBlur(10))
        crop.alpha_composite(glow)
        lay2 = Image.new("RGBA", crop.size, (0, 0, 0, 0))
        ImageDraw.Draw(lay2).line(pts, fill=(255, 70, 80, 255), width=9, joint="curve")
        crop.alpha_composite(lay2)
    rest = [(x - hx + C, y - hy + C) for x, y in R[k:]]
    if len(rest) > 1:
        ImageDraw.Draw(crop).line(rest, fill=(90, 95, 110, 255), width=5)
    crop = crop.rotate(head + 90, Image.BICUBIC)       # курс — вверх
    q = project_quad(crop.width, crop.height, 52, 0, 0, SW / 2, SH * 0.52, 1.25, f=1100)
    co = persp_coeffs(q, [(0, 0), (crop.width, 0), (crop.width, crop.height), (0, crop.height)])
    img = Image.new("RGBA", (SW, SH), (8, 9, 12, 255))
    img.alpha_composite(crop.transform((SW, SH), Image.PERSPECTIVE, co, Image.BICUBIC))
    # туман к горизонту
    fog = np.zeros((SH, SW, 4), np.uint8)
    fog[..., :3] = (8, 9, 12)
    fog[..., 3] = (np.clip(1 - (np.arange(SH) - 300) / 450, 0, 1) * 255).astype(np.uint8)[:, None]
    img.alpha_composite(Image.fromarray(fog, "RGBA"))
    # позиция головы маршрута на экране = проекция центра кропа
    co_inv = persp_coeffs([(0, 0), (crop.width, 0), (crop.width, crop.height), (0, crop.height)], q)
    u, v = crop.width / 2, crop.height / 2
    a, b_, c, d_, e, f_, g, h = co_inv
    den = g * u + h * v + 1
    px, py = (a * u + b_ * v + c) / den, (d_ * u + e * v + f_) / den
    d = ImageDraw.Draw(img, "RGBA")
    pr = (t * 1.4) % 1
    r = 20 + 60 * pr
    d.ellipse([px - r, py - r * 0.55, px + r, py + r * 0.55], outline=(255, 60, 70, int(200 * (1 - pr))), width=4)
    d.ellipse([px - 22, py - 22, px + 22, py + 22], fill=(255, 255, 255, 255))
    d.ellipse([px - 15, py - 15, px + 15, py + 15], fill=(240, 30, 45, 255))
    # карточка маршрута
    d.rounded_rectangle([40, 90, SW - 40, 250], radius=34, fill=(20, 20, 24, 230))
    i = min(len(REG) - 1, int(fr * len(REG)))
    d.text((80, 140), "регион", font=font(FONT_UI_REG, 28), fill=(140, 140, 150), anchor="lm")
    d.text((80, 196), f"{REG[0]}  →  {REG[i]}", font=font(FONT_BIG, 56), fill=(250, 250, 250), anchor="lm")
    km = int(fr * 1362)
    d.text((SW - 80, 140), "геолокация скрыта", font=font(FONT_UI_REG, 24), fill=(255, 80, 90), anchor="rm")
    d.text((SW - 80, 196), f"{km} км", font=font(FONT_UI, 40), fill=(220, 220, 228), anchor="rm")
    return img.convert("RGB")


def drunk(img, t, amt=1.0):
    f = np.asarray(img, np.float32)
    ys = np.arange(SH)
    sh = (amt * (12 * np.sin(ys * 0.010 + t * 2.6) + 6 * np.sin(ys * 0.027 - t * 4.1))).astype(int)
    f = f[ys[:, None], (np.arange(SW)[None, :] - sh[:, None]) % SW]
    dv = int(amt * (16 + 12 * math.sin(t * 1.9)))
    f = f * 0.62 + np.roll(f, dv, 1) * 0.38
    return Image.fromarray(np.clip(f, 0, 255).astype(np.uint8))


# ═════════════════════════════ SHOT LIST ═════════════════════════════
# (старт в долях, сцена, камера, переход-вход, длительность перехода в долях)
# камера: z0,z1, rot0,rot1, fx,fy (фокус сцены), ox0,ox1, oy0,oy1
def cam(z0=1.04, z1=1.12, r0=0.0, r1=0.0, fx=None, fy=None, ox=(0, 0), oy=(0, 0)):
    return dict(z0=z0, z1=z1, r0=r0, r1=r1, fx=fx, fy=fy, ox=ox, oy=oy)


SHOTS = [
    (0.00, "chat_wide",   cam(1.00, 1.10, -1.0, 0.6), "fadein", 0.0),
    (1.75, "chat_close",  cam(1.00, 1.06, 0.8, -0.4), "leak", 0.6),
    (2.75, "rain",        cam(1.04, 1.14, -0.6, 0.6), "leak", 0.6),
    (3.50, "chat_macro",  cam(1.00, 1.10, 0, 1.0), "whip_up", 0.32),
    (4.00, "type",        cam(1.10, 1.02, -2.0, 0.0), "zoom", 0.5),
    (5.00, "call",        cam(1.02, 1.10, 0, -1.0), "whip", 0.32),
    (5.75, "polaroid",    cam(1.10, 1.20, 1.0, -0.5), "spin", 0.4),
    (6.75, "missed",      cam(1.02, 1.12, -0.8, 0.4), "whip_up", 0.3),
    (7.50, "street",      cam(1.25, 1.06, 0, 0, None, 700), "flash", 0.36),
    (8.50, "glass_macro", cam(1.70, 1.85, -1.5, 1.5, 360, 560), "zoom", 0.4),
    (9.50, "glass_wide",  cam(1.05, 1.14, 1.0, -1.0, None, 600), "leak", 0.5),
    (10.25, "rain_drunk", cam(1.12, 1.22, 0, 2.0), "spin", 0.4),
    (10.75, "glass_close", cam(1.35, 1.45, 2.0, -1.0, 360, 620), "glitch", 0.22),
    (11.25, "road",       cam(1.03, 1.12, 0, 0), "zoom", 0.4),
    (12.25, "road_close", cam(1.60, 1.75, 1.5, -1.5, 520, 420), "whip", 0.3),
    (13.00, "map",        cam(1.02, 1.08, 0, 0), "flash", 0.36),
    (14.50, "plate",      cam(1.08, 1.18, -1.0, 1.0, None, 700), "glitch", 0.24),
    (15.50, "type2",      cam(1.20, 1.04, 2.0, 0), "zoom", 0.4),
    (16.25, "street_far", cam(1.02, 1.12, 0, 0), "whip_up", 0.3),
    (17.00, "unavail",    cam(1.00, 1.08, 0, 0), "leak", 0.5),
]


def render_shot(name, t, lt, b, bump):
    c = None
    if name in ("chat_wide", "chat_close", "chat_macro"):
        ui = ui_chat(t)
        if name == "chat_wide":
            pose = (6 + 2 * math.sin(t), lerp(22, 10, e_io(lt / 1.2)), lerp(-6, -3, e_io(lt / 1.2)), 0.66, SW / 2, SH / 2 + 10)
        elif name == "chat_close":
            pose = (4, lerp(-6, -12, lt), 3, 1.08, SW / 2 + 50, SH / 2 + 30)
        else:
            pose = (8, 6, -2, 1.75, SW / 2 + 260, SH / 2 - 200)
        img = scene_phone(ui, t, pose)
    elif name == "call":
        img = scene_phone(ui_call(t), t, (10, lerp(-16, -6, e_io(lt / 0.6)), 4, 0.72, SW / 2, SH / 2), shake=1.0)
    elif name == "missed":
        img = scene_phone(ui_missed(t), t, (6, 14, -3, 0.98, SW / 2 - 10, SH / 2 + 160))
    elif name == "unavail":
        pose = (lerp(4, 14, e_io(lt / 1.0)), lerp(-8, -20, e_io(lt / 1.0)), -2, lerp(0.74, 0.66, e_io(lt)), SW / 2, SH / 2)
        img = scene_phone(ui_unavail(lt), t, pose)
    elif name in ("rain", "rain_drunk"):
        img = scene_rain(t, lt)
        if name == "rain_drunk":
            img = drunk(img, t, 1.0)
    elif name in ("type", "type2"):
        img = scene_type(t, b)
    elif name == "polaroid":
        img = scene_polaroid(t, lt)
    elif name in ("street", "street_far"):
        img = me.scene_street(A.old, t, b, 0)
    elif name.startswith("glass"):
        img = drunk(me.scene_glass(A.old, t, b, bump), t, 0.8 if name != "glass_macro" else 0.5)
    elif name in ("road", "road_close"):
        img = me.scene_road(A.old, t, b, bump)
    elif name == "plate":
        img = me.scene_plate(A.old, t, b, bump)
    elif name == "map":
        img = scene_map(t, lt)
    else:
        img = Image.new("RGB", (SW, SH))
    return img


def shot_frame(idx, t, b, bump):
    st, name, cm, _, _ = SHOTS[idx]
    t0 = TL.time(st) if idx else 0.0
    t1 = TL.time(SHOTS[idx + 1][0]) if idx + 1 < len(SHOTS) else DUR
    lt = t - t0
    p = e_io(lt / max(0.1, t1 - t0))
    img = render_shot(name, t, max(lt, 0), b, bump)
    z = lerp(cm["z0"], cm["z1"], p) * (1 + 0.035 * bump)
    rot = lerp(cm["r0"], cm["r1"], p)
    return camera(img, z, rot, cm["fx"], cm["fy"], lerp(*cm["ox"], p), lerp(*cm["oy"], p))


# ═════════════════════════════ TRANSITIONS ═════════════════════════════
def zoom_blur(img, z, s, n=5):
    if s < 0.02:
        return camera(img, z)
    acc = None
    for k in range(n):
        im = camera(img, z * (1 + s * 0.09 * k))
        acc = im if acc is None else Image.blend(acc, im, 1 / (k + 1))
    return acc


def hblur(img, k, vertical=False):
    k = int(k)
    if k < 2:
        return img
    if vertical:
        return img.resize((SW, max(8, SH // k)), Image.BOX).resize((SW, SH), Image.BILINEAR)
    return img.resize((max(8, SW // k), SH), Image.BOX).resize((SW, SH), Image.BILINEAR)


def exposure(img, e):
    if e <= 0.001:
        return img
    f = np.asarray(img, np.float32) / 255
    f = 1 - (1 - f) * (1 - e) ** 1.3
    return Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))


def transition(kind, Aim, Bim, p, t):
    """Aim/Bim — функции, возвращающие кадр уходящего/входящего шота. p ∈ [0,1]."""
    if kind == "zoom":
        if p < 0.5:
            q = e_in(p * 2)
            out = zoom_blur(Aim(), 1 + 0.55 * q, q)
        else:
            q = 1 - e_out((p - 0.5) * 2)
            out = zoom_blur(Bim(), 1 + 0.45 * q, q)
        return exposure(out, 0.55 * math.exp(-((p - 0.5) / 0.12) ** 2))
    if kind in ("whip", "whip_up"):
        s = e_io(p)
        a, b = Aim(), Bim()
        canvas = Image.new("RGB", (SW, SH))
        if kind == "whip":
            off = int(s * SW)
            canvas.paste(a, (-off, 0)); canvas.paste(b, (SW - off, 0))
            return hblur(canvas, 1 + 34 * math.sin(math.pi * p))
        off = int(s * SH)
        canvas.paste(a, (0, -off)); canvas.paste(b, (0, SH - off))
        return hblur(canvas, 1 + 40 * math.sin(math.pi * p), vertical=True)
    if kind == "spin":
        if p < 0.5:
            q = e_in(p * 2)
            im = camera(Aim(), 1 + 0.35 * q, 28 * q)
        else:
            q = 1 - e_out((p - 0.5) * 2)
            im = camera(Bim(), 1 + 0.35 * q, -28 * q)
        r = 9 * math.sin(math.pi * p)
        return im.filter(ImageFilter.GaussianBlur(r)) if r > 0.6 else im
    if kind == "flash":
        if p < 0.5:
            return exposure(Aim(), e_in(p * 2) * 0.97)
        return exposure(Bim(), (1 - e_out((p - 0.5) * 2)) * 0.97)
    if kind == "leak":
        w = e_io(p)
        im = Image.blend(Aim(), Bim(), w)
        f = np.asarray(im, np.float32) / 255
        xx = np.linspace(0, 1, SW)[None, :, None]
        yy = np.linspace(0, 1, SH)[:, None, None]
        cx = -0.3 + 1.6 * p
        leak = np.exp(-(((xx - cx) / 0.35) ** 2 + ((yy - 0.35) / 0.6) ** 2)) * math.sin(math.pi * p) * 0.9
        f = f + leak * np.array([1.0, 0.35, 0.18], np.float32) + leak ** 2 * 0.4
        return Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
    if kind == "glitch":
        im = Aim() if p < 0.5 else Bim()
        g = math.sin(math.pi * p)
        f = np.asarray(im).copy()
        rng = np.random.default_rng(int(t * 1000))
        for _ in range(int(4 + 10 * g)):
            y = int(rng.integers(0, SH - 20)); h = int(rng.integers(8, 90))
            f[y:y + h] = np.roll(f[y:y + h], int(rng.integers(-180, 180) * g), 1)
        k = int(4 + 22 * g)
        f = np.stack([np.roll(f[..., 0], k, 1), f[..., 1], np.roll(f[..., 2], -k, 1)], -1)
        return Image.fromarray(f)
    if kind == "fadein":
        return exposure(Bim(), 0) if p >= 1 else Image.blend(Image.new("RGB", (SW, SH)), Bim(), e_out(p))
    return Bim() if p >= 0.5 else Aim()


# ═════════════════════════════ CAPTIONS (1080x1920) ═════════════════════════════
CAP_SIZE = 108
_wcache = {}


def word_img(word, color, blur, size=CAP_SIZE):
    k = (word, color, blur, size)
    if k in _wcache:
        return _wcache[k]
    f = font(FONT_BIG, size)
    l, tp, r, bt = f.getbbox(word)
    pad = 60
    w_, h_ = r - l + 2 * pad, bt - tp + 2 * pad
    txt = Image.new("L", (w_, h_), 0)
    ImageDraw.Draw(txt).text((pad - l, pad - tp), word, font=f, fill=255)
    out = Image.new("RGBA", (w_, h_), (0, 0, 0, 0))
    sh = txt.filter(ImageFilter.GaussianBlur(16)).point(lambda v: int(v * 0.85))
    shadow = Image.new("RGBA", (w_, h_), (0, 0, 0, 255)); shadow.putalpha(sh)
    out.alpha_composite(shadow, (0, 8))
    if color != (255, 255, 255):
        gl = txt.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.7))
        glow = Image.new("RGBA", (w_, h_), color + (255,)); glow.putalpha(gl)
        out.alpha_composite(glow)
    face = Image.new("RGBA", (w_, h_), color + (255,)); face.putalpha(txt)
    out.alpha_composite(face)
    if blur > 0:
        out = out.filter(ImageFilter.GaussianBlur(blur))
    _wcache[k] = out
    return out


def layout(words, size=CAP_SIZE, maxw=930, space=26):
    f = font(FONT_BIG, size)
    ws = [f.getbbox(w)[2] - f.getbbox(w)[0] for w in words]
    rows, cur, cw = [], [], 0
    for i, w in enumerate(ws):
        if cur and cw + space + w > maxw:
            rows.append(cur); cur, cw = [], 0
        cw += (space if cur else 0) + w
        cur.append(i)
    rows.append(cur)
    pos = [None] * len(words)
    lh = size * 1.14
    for r, row in enumerate(rows):
        tw = sum(ws[i] for i in row) + space * (len(row) - 1)
        x = W / 2 - tw / 2
        for i in row:
            pos[i] = (x + ws[i] / 2, (r - (len(rows) - 1) / 2) * lh)
            x += ws[i] + space
    return pos


def draw_words(layer, words, times, t, t_exit, yc, size=CAP_SIZE, accent=True):
    pos = layout(words, size)
    ex = cl((t - t_exit) / 0.2) if t_exit is not None else 0.0
    for i, (w, ts) in enumerate(zip(words, times)):
        p = (t - ts) / 0.34
        if p <= 0:
            continue
        a = e_out(p * 1.5) * (1 - e_in(ex))
        if a <= 0.01:
            continue
        dy = 54 * (1 - e_out(p)) - 40 * e_in(ex)
        sc = lerp(0.8, 1.0, e_back(p, 1.9)) * (1 + 0.06 * e_in(ex))
        bl = int(round((1 - e_out(p * 1.3)) * 4 + e_in(ex) * 4)) * 2
        nxt = times[i + 1] if i + 1 < len(times) else 1e9
        hot = accent and (t < nxt + 0.12)
        im = word_img(w, RED if hot else (255, 255, 255), bl, size)
        if hot and t > nxt:  # плавный переход красный → белый
            wh = word_img(w, (255, 255, 255), bl, size)
            im = Image.blend(im, wh, cl((t - nxt) / 0.12))
        if sc != 1.0:
            im = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.BICUBIC)
        im = with_alpha(im, a)
        x, y = pos[i]
        layer.alpha_composite(im, (int(x - im.width / 2), int(yc + y + dy - im.height / 2)))


def captions(t):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    yc = H * 0.665
    # хук до первой строчки
    hook_end = TL.time(3.35)
    if t < hook_end + 0.25:
        words = ["POV:", "ты", "пишешь", "ему", "в", "3", "ночи"]
        times = [0.18 + 0.09 * k for k in range(len(words))]
        draw_hook(layer, words, times, t, hook_end, H * 0.735)
    for j, ch in enumerate(CHUNKS):
        ts = [TL.time(b) for b, _ in ch]
        nxt = TL.time(CHUNKS[j + 1][0][0]) - 0.16 if j + 1 < len(CHUNKS) else None
        if t < ts[0] - 0.01 or (nxt is not None and t > nxt + 0.25):
            continue
        draw_words(layer, [w for _, w in ch], ts, t, nxt, yc)
    return layer


def draw_hook(layer, words, times, t, t_exit, yc):
    size = 76
    f = font(FONT_BIG, size)
    ex = cl((t - t_exit) / 0.22)
    rows = [words[:4], words[4:]]
    k = 0
    for r, row in enumerate(rows):
        ws = [f.getbbox(w)[2] - f.getbbox(w)[0] for w in row]
        tw = sum(ws) + 20 * (len(row) - 1)
        x = W / 2 - tw / 2
        for w, wd in zip(row, ws):
            p = (t - times[k]) / 0.32
            k += 1
            if p > 0:
                a = e_out(p * 1.5) * (1 - e_in(ex))
                col = RED if r == 1 else (255, 255, 255)
                im = with_alpha(word_img(w, col, int(round((1 - e_out(p)) * 3)) * 2 + int(ex * 6), size), a)
                dy = 36 * (1 - e_out(p)) - 30 * e_in(ex)
                layer.alpha_composite(im, (int(x + wd / 2 - im.width / 2), int(yc + (r - 0.5) * 92 + dy - im.height / 2)))
            x += wd + 20


# ═════════════════════════════ POST (1080x1920) ═════════════════════════════
def post(img, i, t, fx_glitch, flash):
    small = img.resize((W // 4, H // 4), Image.BILINEAR)
    s = np.asarray(small, np.float32) / 255
    lum = s.max(2, keepdims=True)
    hi = np.clip((lum - 0.5) / 0.5, 0, 1) ** 1.6 * s
    hi_im = Image.fromarray((hi * 255).astype(np.uint8))
    b1 = np.asarray(hi_im.filter(ImageFilter.GaussianBlur(5)).resize((W, H), Image.BILINEAR), np.float32) / 255
    b2 = np.asarray(hi_im.filter(ImageFilter.GaussianBlur(18)).resize((W, H), Image.BILINEAR), np.float32) / 255
    f = np.asarray(img, np.float32) / 255
    f = f + b1 * 0.45 + b2 * 0.55
    f[..., 0] += b2[..., 0] * 0.22                       # халация
    # грейд: тени в холод, красный живой, лёгкая плёночная кривая
    l = (0.3 * f[..., 0] + 0.59 * f[..., 1] + 0.11 * f[..., 2])[..., None]
    red = np.clip((f[..., 0] - np.maximum(f[..., 1], f[..., 2])) * 2.5, 0, 1)[..., None]
    f = l + (f - l) * (0.78 + 0.4 * red)
    f = f + (1 - np.clip(l * 3, 0, 1)) * np.array([-0.004, 0.006, 0.02], np.float32)
    f = np.clip(f, 0, 1.5)
    f = f / (1 + 0.32 * f) * 1.32                        # мягкий плечо-тонмаппинг
    f = f * f * (3 - 2 * np.clip(f, 0, 1)) * 0.35 + f * 0.65
    if fx_glitch > 0.02:
        k = int(2 + 16 * fx_glitch)
        f = np.stack([np.roll(f[..., 0], k, 1), f[..., 1], np.roll(f[..., 2], -k, 1)], -1)
    else:
        f = np.stack([np.roll(f[..., 0], 1, 1), f[..., 1], np.roll(f[..., 2], -1, 1)], -1)
    if flash > 0.001:
        f = f + (1 - f) * flash
    return f


def finish(f, i):
    f = f * A.vig + A.grain[i % 8] * 0.07
    return (np.clip(f, 0, 1) * 255).astype(np.uint8)


# ═════════════════════════════ FRAME ═════════════════════════════
def bump_at(b):
    if b < DROP_BEAT:
        return 0.0
    ph = b - math.floor(b)
    amp = 1.0 if (int(math.floor(b)) - DROP_BEAT) % 4 == 0 else 0.55
    return amp * (1 - math.exp(-ph * 40)) * math.exp(-ph * 6)


def frame(i):
    t = i / FPS
    b = TL.beat(t)
    bump = bump_at(b)
    times = [TL.time(s[0]) for s in SHOTS]
    times[0] = 0.0
    idx = max(k for k in range(len(SHOTS)) if times[k] <= t + 1e-9)
    img = None
    fx_glitch = 0.0
    # активный переход?
    for k in (idx, idx + 1):
        if 0 < k < len(SHOTS):
            kind, d = SHOTS[k][3], TL.time(SHOTS[k][0] + SHOTS[k][4] / 2) - TL.time(SHOTS[k][0] - SHOTS[k][4] / 2)
            tc = times[k]
            if d > 0 and tc - d / 2 <= t < tc + d / 2:
                p = (t - (tc - d / 2)) / d
                img = transition(kind, lambda: shot_frame(k - 1, t, b, bump), lambda: shot_frame(k, t, b, bump), p, t)
                if kind == "glitch":
                    fx_glitch = math.sin(math.pi * p)
                if kind == "zoom":
                    fx_glitch = 0.35 * math.sin(math.pi * p)
                break
    if img is None:
        img = shot_frame(idx, t, b, bump)
        if SHOTS[0][3] == "fadein" and t < 0.25:
            img = Image.blend(Image.new("RGB", (SW, SH)), img, e_out(t / 0.25))
    big = img.resize((W, H), Image.BICUBIC)
    flash = 0.10 * bump if b >= DROP_BEAT else 0.0
    f = post(big, i, t, fx_glitch, flash)
    cap = captions(t)
    bb = cap.getbbox()
    if bb:
        x0, y0, x1, y1 = bb
        c = np.asarray(cap.crop(bb), np.float32) / 255
        a = c[..., 3:4]
        f[y0:y1, x0:x1] = f[y0:y1, x0:x1] * (1 - a) + c[..., :3] * a
    if t > DUR - 0.3:   # мягкий уход в черноту → луп
        f = f * (1 - e_in((t - (DUR - 0.3)) / 0.3))
    return finish(f, i).tobytes()


# ═════════════════════════════ MAIN ═════════════════════════════
class TimeMap:
    def __init__(self, tl):
        self.tl = tl

    def beat(self, t):
        return self.tl.beat(t)

    def time(self, b):
        return float(np.interp(b, self.tl.bi, self.tl.bt))


TL = None
CHUNKS = None


def main():
    global A, TL, CHUNKS, DUR
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--dur", type=float, default=12.0)
    ap.add_argument("--out", default="ne_ishchi_menya_v3.mp4")
    ap.add_argument("--frames", help="только превью-кадры: список номеров через запятую")
    ap.add_argument("--jobs", type=int, default=os.cpu_count())
    a = ap.parse_args()
    DUR = a.dur
    me.DUR = DUR
    ctx0 = max(0.0, a.start - 8)
    y = me.ffmpeg_load(a.track, ctx0, (a.start - ctx0) + DUR + 4, 22050, 1)
    an = me.analyze(y, 22050)
    bts = an["beats"] + ctx0 - a.start
    beats = bts[(bts > -0.05) & (bts < DUR + 0.05)]
    print(f"BPM {an['bpm']:.1f} · {len(beats)} beats in window")
    TL = TimeMap(me.Timeline(beats, 0, np.array([])))
    CHUNKS = me.parse_lyrics(me.DEFAULT_LYRICS)
    A = Assets3()
    if a.frames:
        os.makedirs("preview", exist_ok=True)
        for s in a.frames.split(","):
            i = int(s)
            Image.frombytes("RGB", (W, H), frame(i)).save(f"preview/v3_{i:04d}.jpg", quality=88)
        return
    stereo = me.ffmpeg_load(a.track, a.start, DUR, SR, 2)
    stereo = np.pad(stereo, ((0, max(0, int(DUR * SR) - len(stereo))), (0, 0)))[: int(DUR * SR)]
    wav = os.path.abspath("_v3_audio.wav")
    me.write_wav(wav, me.dirty_audio(stereo, 0, None, clean=True))
    nfr = int(round(DUR * FPS))
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", "-", "-i", wav, "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-maxrate", "32M",
           "-bufsize", "64M", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.2", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "256k", "-ar", str(SR), "-shortest", "-movflags", "+faststart", a.out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    ctx = mp.get_context("fork")
    with ctx.Pool(a.jobs) as pool:
        for k, fr in enumerate(pool.imap(frame, range(nfr), chunksize=3)):
            p.stdin.write(fr)
            if k % 60 == 0:
                print(f"  {k}/{nfr}", flush=True)
    p.stdin.close()
    if p.wait() != 0:
        sys.exit("ffmpeg failed")
    os.remove(wav)
    print("done →", a.out)


if __name__ == "__main__":
    main()
