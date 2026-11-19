#!/usr/bin/env python3
"""
FLUFFY BARBARA — LONELY · 15s dirty TikTok edit generator.

Весь видеоряд рисуется процедурно (numpy + PIL), монтаж режется по битам.

  # черновик под встроенный guide-бит (140 BPM):
  python3 make_edit.py

  # под настоящий трек — укажи секунду, где падает дроп:
  python3 make_edit.py --track lonely.mp3 --drop 41.2

  # или просто начало 15-секундного окна:
  python3 make_edit.py --track lonely.mp3 --start 37.5

Биты, сильные доли и удары детектятся из аудио, монтаж подстраивается сам.
"""
import argparse
import math
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ───────────────────────────── config ─────────────────────────────
W, H = 720, 1280          # внутренний рендер; апскейл до 1080x1920 в ffmpeg (зерно станет крупнее — так и надо)
OUT_W, OUT_H = 1080, 1920
FPS = 30
DUR = 15.0
SR = 44100
DROP_BEAT = 4             # дроп на 5-й доле окна (4 доли интро)

FONT_BIG = "/usr/share/fonts/opentype/inter/InterDisplay-Black.otf"
FONT_UI = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"
FONT_UI_REG = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
FONT_MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

RED = (225, 18, 32)


# ═════════════════════════════ AUDIO I/O ═════════════════════════════
def ffmpeg_load(path, start, dur, sr, channels):
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-t", f"{dur:.4f}",
           "-i", path, "-ac", str(channels), "-ar", str(sr), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.float32).copy()
    return a.reshape(-1, channels) if channels > 1 else a


def write_wav(path, stereo, sr=SR):
    pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
    import wave
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def fft_lowpass(x, sr, fc, width=1.0):
    """Мягкий FFT-лоупасс (x: [n] или [n, ch])."""
    n = x.shape[0]
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(n, 1 / sr)
    g = 1.0 / (1.0 + (f / fc) ** (4 / width))
    return np.fft.irfft(X * (g[:, None] if x.ndim > 1 else g), n=n, axis=0).astype(np.float32)


def fft_highpass(x, sr, fc):
    n = x.shape[0]
    X = np.fft.rfft(x, axis=0)
    f = np.fft.rfftfreq(n, 1 / sr)
    g = 1.0 - 1.0 / (1.0 + (f / fc) ** 4)
    return np.fft.irfft(X * (g[:, None] if x.ndim > 1 else g), n=n, axis=0).astype(np.float32)


def crackle(n, sr, rng, density=18.0, level=0.12):
    """Винил: щелчки + шипение."""
    out = rng.normal(0, 0.012, n).astype(np.float32)
    k = rng.poisson(density * n / sr)
    pos = rng.integers(0, n - 64, k)
    for p in pos:
        L = int(rng.integers(8, 48))
        out[p:p + L] += rng.uniform(-1, 1) * np.exp(-np.arange(L) / (L / 4)) * rng.uniform(0.2, 1.0)
    out = fft_highpass(out, sr, 900)
    return out * level


# ═════════════════════════════ BEAT ANALYSIS ═════════════════════════════
def analyze(y, sr, bpm_hint=None):
    """Онсет-огибающая (spectral flux) → темп (автокорреляция) → биты (DP, Ellis 2007)."""
    hop, nfft = 512, 2048
    y = np.pad(y, (nfft // 2, nfft // 2))
    nfr = 1 + (len(y) - nfft) // hop
    idx = np.arange(nfft)[None, :] + hop * np.arange(nfr)[:, None]
    win = np.hanning(nfft).astype(np.float32)
    S = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    L = np.log1p(100 * S)
    freqs = np.fft.rfftfreq(nfft, 1 / sr)
    d = np.maximum(0, np.diff(L, axis=0, prepend=L[:1]))
    onset = d.sum(axis=1)
    low = d[:, freqs < 160].sum(axis=1)
    onset = onset - np.convolve(onset, np.ones(16) / 16, mode="same")
    onset = np.maximum(onset, 0)
    onset /= onset.max() + 1e-9
    low /= low.max() + 1e-9
    fps = sr / hop
    times = np.arange(nfr) * hop / sr

    # темп
    if bpm_hint:
        bpm = float(bpm_hint)
    else:
        ac = np.correlate(onset - onset.mean(), onset - onset.mean(), mode="full")[nfr - 1:]
        lags = np.arange(len(ac))
        with np.errstate(divide="ignore"):
            bpms = 60 * fps / np.maximum(lags, 1)
        prior = np.exp(-0.5 * (np.log2(bpms / 130.0) / 0.9) ** 2)
        valid = (bpms >= 65) & (bpms <= 200)
        score = np.where(valid, ac * prior, -np.inf)
        best = int(np.argmax(score))
        # параболическая доводка лага
        if 1 <= best < len(ac) - 1:
            a, b, c = ac[best - 1], ac[best], ac[best + 1]
            off = 0.5 * (a - c) / (a - 2 * b + c + 1e-12)
        else:
            off = 0
        bpm = 60 * fps / (best + off)
    period = 60 * fps / bpm

    # DP-трекер битов
    tight = 100.0
    score = onset.copy()
    back = -np.ones(nfr, dtype=int)
    for i in range(nfr):
        lo, hi = int(i - 2 * period), int(i - period / 2)
        if hi < 0:
            continue
        lo = max(lo, 0)
        prev = np.arange(lo, hi + 1)
        pen = -tight * np.log((i - prev) / period) ** 2
        cand = score[prev] + pen
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[i] += cand[j]
            back[i] = prev[j]
    # конец: лучший пик в последнем периоде
    tail = np.arange(max(0, nfr - int(period)), nfr)
    i = int(tail[np.argmax(score[tail])])
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    beats = np.array(beats[::-1])
    bt = times[beats]
    # сильная доля: фаза из 4 с максимальной энергией низа
    ph = max(range(4), key=lambda k: low[beats[k::4]].sum() if len(beats[k::4]) else 0)
    # сильные удары (для глитчей)
    pk = (onset > 0.35) & (onset >= np.roll(onset, 1)) & (onset >= np.roll(onset, -1))
    hits = times[pk]
    return dict(bpm=bpm, beats=bt, downbeat_phase=ph, hits=hits,
                onset=onset, low=low, times=times)


# ═════════════════════════════ GUIDE TRACK ═════════════════════════════
def synth_guide(bpm=140.0, seed=7):
    """Тёмный trap-гайд в F minor: 808, клэп, хэты с роллами, пэд, плак-лид."""
    rng = np.random.default_rng(seed)
    n = int(DUR * SR) + SR
    t = np.arange(n) / SR
    spb = 60 / bpm
    out = np.zeros((n, 2), np.float32)
    nbeats = int(DUR / spb) + 2

    def hz(m):
        return 440.0 * 2 ** ((m - 69) / 12)

    # аккорды по такту: Fm, Db, Ab, Eb
    prog = [(53, [65, 68, 72]), (49, [61, 65, 68]), (56, [63, 68, 72]), (51, [63, 67, 70])]

    def chord_at(beat):
        return prog[int(beat // 4) % 4]

    def add(sig, start, gain=1.0, pan=0.0):
        s = int(start * SR)
        if s >= n:
            return
        e = min(n, s + len(sig))
        l, r = math.cos((pan + 1) * math.pi / 4), math.sin((pan + 1) * math.pi / 4)
        out[s:e, 0] += sig[:e - s] * gain * l * 1.41
        out[s:e, 1] += sig[:e - s] * gain * r * 1.41

    # ── пэд (на всём протяжении), сайдчейн позже
    pad = np.zeros(n, np.float32)
    for b in range(0, nbeats, 4):
        root, notes = chord_at(b)
        s, e = int(b * spb * SR), min(n, int((b + 4) * spb * SR) + 2000)
        tt = np.arange(e - s) / SR
        seg = np.zeros(e - s, np.float32)
        for m in notes + [notes[0] - 12]:
            for det in (-0.12, 0.0, 0.11):
                f = hz(m + det)
                ph = rng.uniform(0, 1)
                seg += (2 * ((f * tt + ph) % 1) - 1) * 0.06
        env = np.minimum(1, tt / 0.04) * np.minimum(1, (tt[-1] - tt) / 0.05 + 1e-3)
        pad[s:e] += seg * env
    pad = fft_lowpass(pad, SR, 1400)

    # ── ударные/808 — только с дропа
    kick_env = np.zeros(n, np.float32)
    drop_t = DROP_BEAT * spb
    kicks_in_bar = [0, 1.5, 2.75]
    snares_in_bar = [2]
    for bar in range(nbeats // 4 + 1):
        for kb in kicks_in_bar:
            beat = bar * 4 + kb
            ts = beat * spb
            if ts < drop_t - 1e-6 or ts >= DUR:
                continue
            # следующий кик → длина 808
            nxt = min([(bar * 4 + k) * spb for k in kicks_in_bar if (bar * 4 + k) * spb > ts + 1e-6] + [(bar + 1) * 4 * spb])
            L = int((nxt - ts) * SR)
            tt = np.arange(L) / SR
            root, _ = chord_at(beat)
            f0 = hz(root - 24 + (12 if root < 50 else 0))
            f = f0 * (1 + 2.2 * np.exp(-tt / 0.025))
            ph = 2 * np.pi * np.cumsum(f) / SR
            amp = np.exp(-tt / 0.9) * np.minimum(1, (L - np.arange(L)) / 300)
            s808 = np.tanh(2.8 * np.sin(ph) * amp) * 0.55
            click = np.sin(2 * np.pi * np.cumsum(160 * np.exp(-tt / 0.012) + 50) / SR) * np.exp(-tt / 0.035) * 0.6
            add((s808 + click).astype(np.float32), ts)
            s = int(ts * SR)
            ke = np.exp(-np.arange(min(L, n - s)) / (0.18 * SR))
            kick_env[s:s + len(ke)] = np.maximum(kick_env[s:s + len(ke)], ke)
        for sb in snares_in_bar:
            ts = (bar * 4 + sb) * spb
            if ts < drop_t - 1e-6 or ts >= DUR:
                continue
            L = int(0.35 * SR)
            tt = np.arange(L) / SR
            nz = rng.normal(0, 1, L).astype(np.float32)
            nz = np.diff(nz, prepend=0)
            env = np.zeros(L)
            for k, off in enumerate((0, 0.011, 0.022)):
                env += (tt >= off) * np.exp(-np.maximum(tt - off, 0) / (0.012 if k < 2 else 0.12))
            tone = np.sin(2 * np.pi * 210 * tt) * np.exp(-tt / 0.05) * 0.5
            add(((nz * 0.35 * env + tone) * 0.9).astype(np.float32), ts, 0.8)
    # хэты: восьмые + роллы
    for b8 in range(0, nbeats * 2):
        ts = b8 * spb / 2
        if ts < drop_t - 1e-6 or ts >= DUR:
            continue
        bar_pos = (b8 / 2) % 8
        subs = [0.0]
        if 6.5 <= bar_pos < 7.0:
            subs = [0, 1 / 3, 2 / 3]          # триоли
        if 7.0 <= bar_pos < 7.5:
            subs = [0, 0.25, 0.5, 0.75]       # 32-е
        for sv in subs:
            L = int(0.04 * SR)
            tt = np.arange(L) / SR
            nz = np.diff(np.diff(rng.normal(0, 1, L + 2)))[:L]
            add((nz * np.exp(-tt / 0.012) * 0.16).astype(np.float32), ts + sv * spb / 2, 1.0,
                pan=0.25 if b8 % 2 else -0.15)
    # плак-лид
    lead = [72, 68, 65, 68, 75, 72, 68, 67]
    for b8 in range(0, nbeats * 2):
        ts = b8 * spb / 2
        if ts < drop_t - 1e-6 or ts >= DUR:
            continue
        m = lead[b8 % 8] + (0 if (b8 // 16) % 2 == 0 else -5 * ((b8 % 8) == 4))
        L = int(0.5 * SR)
        tt = np.arange(L) / SR
        f = hz(m + 12)
        sig = (np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(4 * np.pi * f * tt) + 0.12 * np.sin(6 * np.pi * f * tt))
        sig *= np.exp(-tt / 0.16) * np.minimum(1, tt / 0.003) * 0.13
        add(sig.astype(np.float32), ts, 1.0, pan=-0.3 if b8 % 2 else 0.3)
        add(sig.astype(np.float32), ts + spb * 0.75, 0.35, pan=0.6 if b8 % 2 else -0.6)  # эхо

    side = 1 - 0.75 * kick_env
    out[:, 0] += pad * side * 0.9
    out[:, 1] += pad * side * 0.9
    out = out[:int(DUR * SR)]
    out = np.tanh(out * 1.6) / np.tanh(1.6)
    return out.astype(np.float32), bpm


def dirty_audio(stereo, drop_t, rng, muffle=True, tapestop=True):
    """Интро «из-за стены» (лоупасс + винил) → открытие на дропе; tape-stop в конце."""
    n = stereo.shape[0]
    t = np.arange(n) / SR
    out = stereo.copy()
    if muffle and drop_t > 0.2:
        muff = fft_lowpass(stereo, SR, 520)
        # нарастающий свип в последней доле перед дропом
        x = np.clip((t - (drop_t - 0.35)) / 0.35, 0, 1)
        mix = 1 - x ** 3
        mix[t >= drop_t] = 0
        out = muff * mix[:, None] + stereo * (1 - mix[:, None])
        cr = crackle(n, SR, rng, level=0.9)
        out += (cr * (0.35 + 0.65 * mix))[:, None] * 0.25
    else:
        out += crackle(n, SR, rng, level=0.25)[:, None]
    if tapestop:
        L = int(0.65 * SR)
        seg = out[-L:].copy()
        u = np.arange(L) / L
        speed = (1 - u) ** 1.6
        pos = np.cumsum(speed)
        pos = np.clip(pos, 0, L - 1)
        for c in range(2):
            out[-L:, c] = np.interp(pos, np.arange(L), seg[:, c]) * (1 - u ** 4)
    fade = int(0.012 * SR)
    out[:fade] *= np.linspace(0, 1, fade)[:, None]
    out[-fade:] *= np.linspace(1, 0, fade)[:, None]
    peak = np.abs(out).max()
    return (out / (peak + 1e-9) * 0.93).astype(np.float32)


# ═════════════════════════════ VISUAL HELPERS ═════════════════════════════
_font_cache, _txt_cache = {}, {}


def font(path, size):
    k = (path, size)
    if k not in _font_cache:
        _font_cache[k] = ImageFont.truetype(path, size)
    return _font_cache[k]


def text_rgba(s, path, size, fill=(255, 255, 255), stroke=0, stroke_fill=(0, 0, 0)):
    k = (s, path, size, fill, stroke, stroke_fill)
    if k in _txt_cache:
        return _txt_cache[k]
    f = font(path, size)
    l, tp, r, b = f.getbbox(s, stroke_width=stroke)
    im = Image.new("RGBA", (r - l + 4, b - tp + 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((-l + 2, -tp + 2), s, font=f, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
    _txt_cache[k] = im
    return im


def paste_c(dst, im, cx, cy, scale=1.0):
    if scale != 1.0:
        im = im.resize((max(1, int(im.width * scale)), max(1, int(im.height * scale))), Image.BILINEAR)
    dst.paste(im, (int(cx - im.width / 2), int(cy - im.height / 2)), im)


def to_np(im):
    return np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0


YY, XX = np.mgrid[0:H, 0:W].astype(np.float32)
VIGNETTE = np.clip(1.25 - 0.95 * (((XX - W / 2) / (W * 0.62)) ** 2 + ((YY - H / 2) / (H * 0.62)) ** 2), 0.25, 1)[..., None]
SCAN = np.ones((H, 1, 1), np.float32)
SCAN[::3] = 0.78


class Assets:
    def __init__(self, seed=1):
        rng = np.random.default_rng(seed)
        self.rng = rng
        self.grain = [rng.normal(0, 1, (H, W, 1)).astype(np.float32) for _ in range(10)]
        self.static = [np.repeat(np.repeat(rng.random((H // 4, W // 4, 1), dtype=np.float32), 4, 0), 4, 1)
                       for _ in range(8)]
        # дождь
        self.rain = np.stack([rng.uniform(-100, W + 100, 420), rng.uniform(0, H, 420),
                              rng.uniform(900, 1700, 420), rng.uniform(20, 70, 420)], 1)
        # окна дома
        self.win_cols, self.win_rows = 6, 24
        self.win_on = rng.random((self.win_rows, self.win_cols)) < 0.55
        self.win_cold = rng.random((self.win_rows, self.win_cols)) < 0.35
        self.win_kill = rng.permutation(self.win_rows * self.win_cols)
        self.red_win = (12, 3)
        self._street_base()
        self._type_rows()

    # ── база для сцены «фонарь»
    def _street_base(self):
        cx, ly = W * 0.5, 300
        hw = 26 + np.maximum(YY - ly, 0) * 0.42
        cone = np.clip(1 - np.abs(XX - cx) / hw, 0, 1) ** 1.6 * (YY > ly)
        cone *= np.clip(1.15 - (YY - ly) / 1300, 0.2, 1)
        pool = np.clip(1 - (((XX - cx) / 300) ** 2 + ((YY - 1060) / 70) ** 2), 0, 1) ** 1.2
        glow = np.exp(-(((XX - cx) / 90) ** 2 + ((YY - ly) / 60) ** 2))
        light = np.clip(cone * 0.55 + pool * 0.7 + glow * 1.2, 0, 1.6)
        self.street_light = light[..., None] * np.array([1.0, 0.78, 0.5], np.float32)
        self.street_cone = np.clip(cone + pool * 0.5, 0, 1)
        # силуэт + столб
        m = Image.new("L", (W, H), 0)
        d = ImageDraw.Draw(m)
        px = int(cx + 170)
        d.rectangle([px - 7, ly - 30, px + 7, 1100], fill=255)
        d.line([(px, ly - 26), (cx + 20, ly - 26)], fill=255, width=12)
        d.polygon([(cx - 50, ly - 10), (cx + 40, ly - 10), (cx + 20, ly - 36), (cx - 30, ly - 36)], fill=255)
        fx, fy = cx - 10, 720  # фигура в капюшоне
        d.ellipse([fx - 38, fy, fx + 38, fy + 92], fill=255)
        d.polygon([(fx - 40, fy + 50), (fx + 40, fy + 50), (fx + 78, fy + 140), (fx + 70, fy + 330),
                   (fx - 70, fy + 330), (fx - 78, fy + 140)], fill=255)
        d.polygon([(fx - 55, fy + 320), (fx - 8, fy + 320), (fx - 12, fy + 470), (fx - 46, fy + 470)], fill=255)
        d.polygon([(fx + 8, fy + 320), (fx + 55, fy + 320), (fx + 46, fy + 470), (fx + 12, fy + 470)], fill=255)
        d.rectangle([0, 1100, W, H], fill=0)
        self.street_mask = (np.asarray(m, np.float32) / 255)[..., None]

    # ── полосы «LONELY» для типографской стены
    def _type_rows(self):
        self.rows = []
        for k in range(7):
            style = k % 3
            if k == 3:
                fill, stroke, sf = RED, 0, RED
            elif style == 0:
                fill, stroke, sf = (240, 240, 240), 0, (0, 0, 0)
            else:
                fill, stroke, sf = (0, 0, 0), 4, (235, 235, 235)
            word = text_rgba("LONELY ", FONT_BIG, 170, fill, stroke, sf)
            strip = Image.new("RGB", (word.width * 4, word.height), (0, 0, 0))
            for j in range(4):
                strip.paste(word, (j * word.width, 0), word)
            self.rows.append(np.asarray(strip, np.float32) / 255)


# ═════════════════════════════ SCENES ═════════════════════════════
def osd(img, t, rec=True, label="PLAY"):
    d = ImageDraw.Draw(img)
    f = font(FONT_MONO, 30)
    if rec and int(t * 2) % 2 == 0:
        d.ellipse([40, 112, 64, 136], fill=RED)
    d.text((76, 106), "REC" if rec else label, font=f, fill=(235, 235, 235))
    d.text((W - 180, 106), "03:07 AM", font=f, fill=(235, 235, 235))
    tc = f"SP {int(t // 60):01d}:{int(t % 60):02d}:{int((t * 30) % 30):02d}"
    d.text((40, 150), tc, font=font(FONT_MONO, 24), fill=(200, 200, 200))
    d.text((40, 182), "NOV.19.2026", font=font(FONT_MONO, 24), fill=(200, 200, 200))


def scene_phone(A, t, b, outro=False):
    img = Image.new("RGB", (W, H), (9, 9, 11))
    d = ImageDraw.Draw(img)
    # шапка чата
    d.rectangle([0, 0, W, 350], fill=(18, 18, 21))
    d.text((40, 290), "‹", font=font(FONT_UI, 52), fill=(200, 200, 205), anchor="lm")
    d.ellipse([86, 252, 162, 328], fill=(60, 60, 66))
    d.text((186, 270), "он", font=font(FONT_UI, 40), fill=(240, 240, 240), anchor="lm")
    d.text((186, 312), "был(а) недавно", font=font(FONT_UI_REG, 26), fill=(130, 130, 136), anchor="lm")

    def bubble(txt, y, right=True, col=(46, 46, 52), tcol=(240, 240, 240)):
        f = font(FONT_UI, 46)
        l, tp, r, bt = f.getbbox(txt)
        bw, bh = r - l + 64, 94
        x0 = W - 40 - bw if right else 40
        d.rounded_rectangle([x0, y, x0 + bw, y + bh], radius=38, fill=col)
        d.text((x0 + 32, y + bh / 2), txt, font=f, fill=tcol, anchor="lm")
        return y + bh + 14

    y = 420
    d.text((W / 2, y), "сегодня", font=font(FONT_UI_REG, 26), fill=(110, 110, 115), anchor="mm")
    y += 50
    y = bubble("ты тут?", y)
    if b >= 1 or outro:
        y = bubble("ответь пж", y)
    if b >= 2 or outro:
        d.text((W - 44, y + 4), "Прочитано 03:07", font=font(FONT_UI_REG, 28), fill=(120, 120, 125), anchor="ra")
        y += 50
    typing = (not outro) and (2.5 <= b < 3.5)
    if typing:
        d.rounded_rectangle([40, y, 200, y + 84], radius=38, fill=(32, 32, 36))
        for k in range(3):
            on = int(t * 8 + k) % 3 == 0
            d.ellipse([74 + k * 36, y + 32, 94 + k * 36, y + 52], fill=(220, 220, 220) if on else (90, 90, 95))
    if outro:
        y += 10
        y = bubble("мне одиноко", y, col=(110, 12, 20))
        if b >= 0.5:
            d.text((W - 44, y + 4), "! не доставлено", font=font(FONT_UI, 30), fill=RED, anchor="ra")
    # поле ввода
    d.rounded_rectangle([30, H - 380, W - 30, H - 300], radius=40, fill=(22, 22, 25))
    d.text((70, H - 340), "Сообщение", font=font(FONT_UI_REG, 30), fill=(90, 90, 95), anchor="lm")
    if int(t * 2.5) % 2 == 0:
        d.rectangle([66, H - 360, 69, H - 320], fill=(200, 200, 200))
    osd(img, t)
    return img


def scene_street(A, t, b, k):
    rng = np.random.default_rng(int(t * FPS) * 7 + 3)
    flick = 1.0
    if rng.random() < 0.12:
        flick = rng.uniform(0.05, 0.4)
    light = A.street_light * flick
    rain = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(rain)
    for x, y0, sp, ln in A.rain:
        y = (y0 + sp * t) % (H + 100) - 50
        xx = x + (y - y0) * 0.12
        d.line([(xx, y), (xx + ln * 0.12, y + ln)], fill=200, width=2)
    rain = np.asarray(rain, np.float32)[..., None] / 255
    f = light + rain * (0.07 + A.street_cone[..., None] * 0.85 * flick) * np.array([1, 0.9, 0.8], np.float32)
    # отражение в луже
    refl = f[1100 - (np.arange(H - 1100) + 1)][:, :]
    ripple = (np.sin(np.arange(H - 1100) * 0.6 + t * 9) * 6).astype(int)
    refl = np.stack([np.roll(refl[i], ripple[i], 0) for i in range(len(refl))])
    f[1100:] = refl * 0.35
    f = f * (1 - A.street_mask)
    img = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
    osd(img, t)
    return img


def scene_windows(A, t, b, k):
    img = Image.new("RGB", (W, H), (6, 6, 8))
    d = ImageDraw.Draw(img)
    cw, chh, gx, gy = 86, 104, 26, 30
    x0 = (W - (A.win_cols * cw + (A.win_cols - 1) * gx)) // 2
    total_h = A.win_rows * (chh + gy)
    pan = (t * 38 + b * 6) % (total_h - H + 200)
    killed = set(A.win_kill[: int(max(0, b - DROP_BEAT) * 3)].tolist())
    d.rectangle([x0 - 40, 0, W - x0 + 40, H], fill=(14, 14, 17))
    for r in range(A.win_rows):
        y = 60 + r * (chh + gy) - pan
        if y < -chh or y > H:
            continue
        for c in range(A.win_cols):
            x = x0 + c * (cw + gx)
            idn = r * A.win_cols + c
            if (r, c) == A.red_win:
                d.rectangle([x, y, x + cw, y + chh], fill=RED)
                d.ellipse([x + 30, y + 22, x + 56, y + 50], fill=(10, 0, 0))
                d.rectangle([x + 24, y + 50, x + 62, y + chh], fill=(10, 0, 0))
                continue
            on = A.win_on[r, c] and idn not in killed
            if on:
                col = (95, 140, 210) if A.win_cold[r, c] else (230, 175, 105)
                if A.win_cold[r, c] and int(t * 12 + idn) % 5 == 0:
                    col = (60, 90, 150)
                d.rectangle([x, y, x + cw, y + chh], fill=col)
            else:
                d.rectangle([x, y, x + cw, y + chh], fill=(20, 20, 24))
    osd(img, t)
    return img


HEART = ["..XXX.XXX..", ".XXXXXXXXX.", "XXXXXXXXXXX", "XXXXXXXXXXX", "XXXXXXXXXXX",
         ".XXXXXXXXX.", "..XXXXXXX..", "...XXXXX...", "....XXX....", ".....X....."]
CRACK = [5, 6, 5, 4, 5, 6, 5, 4, 5, 5]


def scene_heart(A, t, b, k, sep=0.0, punch=0.0):
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    cs = int(54 * (1 + 0.12 * punch))
    hw, hh = len(HEART[0]) * cs, len(HEART) * cs
    ox, oy = W // 2 - hw // 2, int(H * 0.42) - hh // 2
    rng = np.random.default_rng(int(t * FPS))
    for r, row in enumerate(HEART):
        for c, ch in enumerate(row):
            if ch != "X":
                continue
            left = c < CRACK[r]
            dx = (-sep if left else sep) * cs + rng.normal(0, 2 + 6 * punch)
            dy = (sep * 0.4 * (r - 4) if left else -sep * 0.2 * (r - 4)) * cs * 0.3
            x, y = ox + c * cs + dx, oy + r * cs + dy
            shade = 1.0 - 0.25 * (r / len(HEART))
            d.rectangle([x, y, x + cs - 3, y + cs - 3], fill=tuple(int(v * shade) for v in RED))
            d.rectangle([x + 6, y + 6, x + 16, y + 16], fill=(255, 120, 120))
    f = to_np(img)
    glow = np.exp(-(((XX - W / 2) / 360) ** 2 + ((YY - H * 0.42) / 360) ** 2))[..., None]
    f = np.maximum(f, glow * np.array([0.35, 0.02, 0.04], np.float32) * (0.6 + 0.6 * punch))
    return Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))


def scene_tunnel(A, t, b, k, punch=0.0):
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    z = t * 1.3 + b * 0.25
    ang = math.sin(t * 1.7) * 0.12 + punch * 0.08
    for j in range(16):
        s = 1.32 ** (j - (z % 1) * 1 - 6)
        hwid, hht = W * 0.62 * s, H * 0.62 * s
        if hwid < 6 or hwid > W * 1.6:
            continue
        pts = []
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x, y = sx * hwid, sy * hht
            pts.append((W / 2 + x * math.cos(ang) - y * math.sin(ang), H * 0.45 + x * math.sin(ang) + y * math.cos(ang)))
        col = RED if (j + int(z)) % 4 == 0 else (230, 230, 230)
        d.line(pts + [pts[0]], fill=col, width=max(2, int(9 * s)))
    paste_c(img, text_rgba("lonely", FONT_BIG, 64, RED), W / 2, H * 0.45, 1 + 0.4 * punch)
    return img


def scene_static(A, t, b, k, text="NO SIGNAL"):
    i = int(t * FPS)
    f = A.static[i % len(A.static)] * 0.85
    f = np.repeat(f, 3, 2)
    bar_y = int((t * 900) % (H + 300)) - 150
    lo, hi = max(0, bar_y), min(H, bar_y + 140)
    if hi > lo:
        f[lo:hi] = np.clip(f[lo:hi] * 1.5 + 0.2, 0, 1)
    img = Image.fromarray((f * 255).astype(np.uint8))
    if text:
        txt = text_rgba(text, FONT_MONO, 58, (240, 240, 240))
        bg = Image.new("RGBA", (txt.width + 40, txt.height + 24), (0, 0, 0, 255))
        paste_c(img, bg, W / 2, H * 0.42)
        paste_c(img, txt, W / 2, H * 0.42)
    return img


def scene_type(A, t, b, k, punch=0.0):
    f = np.zeros((H, W, 3), np.float32)
    rh = A.rows[0].shape[0]
    gap = 6
    total = 7 * (rh + gap)
    y0 = (H - total) // 2
    for r, strip in enumerate(A.rows):
        sw = strip.shape[1] // 4
        direction = 1 if r % 2 else -1
        off = int((t * 260 * direction + b * 80 * direction + r * 137)) % sw
        row = np.roll(strip, -off, axis=1)[:, :W]
        y = y0 + r * (rh + gap)
        h = min(row.shape[0], H - y)
        if y >= 0 and h > 0:
            f[y:y + h] = row[:h]
    if punch > 0.05:
        sq = 1 + 0.18 * punch
        c = H // 2
        src = (np.arange(H) - c) / sq + c
        f = f[np.clip(src.astype(int), 0, H - 1)]
    return Image.fromarray((f * 255).astype(np.uint8))


# ═════════════════════════════ TIMELINE ═════════════════════════════
class Timeline:
    def __init__(self, beats, downbeat_phase, hits):
        beats = np.asarray(beats, float)
        per = float(np.median(np.diff(beats)))
        pre = np.arange(beats[0] - per, -2 * per, -per)[::-1]
        post = np.arange(beats[-1] + per, DUR + 2 * per, per)
        self.bt = np.concatenate([pre, beats, post])
        self.bi = np.arange(len(self.bt)) - len(pre)
        self.per = per
        self.ph = downbeat_phase
        self.hits = np.asarray(hits)
        self.nb = int(np.interp(DUR, self.bt, self.bi))

    def beat(self, t):
        return float(np.interp(t, self.bt, self.bi))

    def hit(self, t):
        past = self.hits[self.hits <= t + 1e-3]
        return float(np.exp(-(t - past[-1]) * 14)) if len(past) else 0.0


def plan(tl, b):
    """→ (scene, intensity, extra) для beat-позиции b."""
    D, N = DROP_BEAT, tl.nb
    if b < D:
        return "phone", 0.25, {}
    if b < D + 1:
        return "type", 1.0, {"flash": True}
    if b < D + 9:
        seq = ["street", "windows", "heart", "tunnel", "street", "type", "windows", "heart"]
        words = {D + 1: "FLUFFY", D + 2: "BARBARA", D + 4: "LONELY", D + 7: "LONELY"}
        return seq[int(b - D - 1) % len(seq)], 0.8, {"word": words.get(int(b))}
    if b < D + 17:
        seq = ["street", "type", "windows", "tunnel"]
        sc = seq[int((b - D - 9) // 2) % len(seq)]
        if (b % 2) > 1.75:
            sc = "static"
        return sc, 0.6, {}
    if b < N - 6:
        seq = ["heart", "street", "type", "windows", "tunnel", "static", "street", "heart"]
        return seq[int((b - D - 17) * 2) % len(seq)], 1.0, {"strobe": True}
    if b < N - 2:
        return "heart", 0.45, {"break": (b - (N - 6)) / 4}
    return "phone_outro", 0.3, {}


# ═════════════════════════════ POST FX (грязь) ═════════════════════════════
def grade(f):
    gray = (0.3 * f[..., 0] + 0.59 * f[..., 1] + 0.11 * f[..., 2])[..., None]
    red = np.clip((f[..., 0] - np.maximum(f[..., 1], f[..., 2])) * 3, 0, 1)[..., None]
    f = gray + (f - gray) * (0.3 + 0.7 * red)
    f = np.clip((f - 0.45) * 1.35 + 0.45, 0, 1)
    f = 0.035 + f * 0.95
    return f * np.array([0.97, 1.0, 0.985], np.float32)


def post(A, img, t, i, inten, punch, hit, flash, prev, extra):
    rng = np.random.default_rng(i * 31 + 5)
    # зум-панч + тряска
    z = 1 + 0.09 * punch * inten
    sx = rng.normal(0, 1) * 14 * punch * inten
    sy = rng.normal(0, 1) * 14 * punch * inten
    if z > 1.001 or abs(sx) > 0.5:
        cw, ch = W / z, H / z
        x0 = min(max((W - cw) / 2 + sx, 0), W - cw)
        y0 = min(max((H - ch) / 2 + sy, 0), H - ch)
        img = img.resize((W, H), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))
    f = to_np(img)
    f = grade(f)
    g = max(punch * inten, hit * inten)
    # пикселизация на сильных ударах
    if hit * inten > 0.75 and rng.random() < 0.5:
        q = int(rng.choice([8, 12, 16]))
        small = f[::q, ::q]
        f = np.repeat(np.repeat(small, q, 0), q, 1)[:H, :W]
    # хроматическая аберрация
    k = int(2 + 18 * g)
    f = np.stack([np.roll(f[..., 0], k, 1), f[..., 1], np.roll(f[..., 2], -k, 1)], -1)
    # слайс-глитч
    if g > 0.3:
        for _ in range(int(3 + 9 * g)):
            y = int(rng.integers(0, H - 10))
            hgt = int(rng.integers(6, 70))
            f[y:y + hgt] = np.roll(f[y:y + hgt], int(rng.integers(-160, 160) * g), 1)
            if rng.random() < 0.3:
                f[y:y + hgt] = f[y:y + hgt][..., ::-1]
    # VHS трекинг-полоса
    if rng.random() < 0.06 + 0.3 * g:
        y = int(rng.integers(0, H - 60))
        f[y:y + 46] = np.clip(np.roll(f[y:y + 46], int(rng.integers(-40, 40)), 1) * 1.4
                              + A.grain[i % 10][y:y + 46] * 0.25, 0, 1)
    # срыв кадровой синхры
    if hit * inten > 0.85 and rng.random() < 0.35:
        f = np.roll(f, int(rng.integers(40, 260)), 0)
    # шлейф
    if prev is not None:
        f = np.maximum(f, prev * (0.42 if extra.get("strobe") else 0.3))
    # вспышка/инверсия
    if flash > 0.01:
        if extra.get("strobe") and int(t * FPS) % 2 == 0:
            f = f * (1 - flash) + (1 - f) * flash
        else:
            f = f + (1 - f) * flash
    # зерно, сканлайны, виньетка
    f = f + A.grain[(i * 7) % 10] * (0.055 + 0.05 * g)
    f = f * SCAN * VIGNETTE
    f = np.clip(f, 0, 1)
    return f


def word_overlay(img, word, phase):
    if not word:
        return img
    s = 1.0 + 0.35 * math.exp(-phase * 9)
    big = text_rgba(word, FONT_BIG, 150 if len(word) < 7 else 118, (250, 250, 250), 6, (0, 0, 0))
    paste_c(img, big, W / 2, H * 0.4, s)
    return img


# ═════════════════════════════ RENDER ═════════════════════════════
def render(tl, wav_path, out_path, preview_dir=None):
    A = Assets()
    nfr = int(DUR * FPS)
    vf = f"scale={OUT_W}:{OUT_H}:flags=bicubic,format=yuv420p"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", "-", "-i", wav_path, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-maxrate", "28M", "-bufsize", "56M",
           "-profile:v", "high", "-r", str(FPS), "-c:a", "aac", "-b:a", "256k", "-ar", str(SR),
           "-shortest", "-movflags", "+faststart", out_path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    prev = None
    last_scene = None
    for i in range(nfr):
        t = i / FPS
        b = tl.beat(t)
        phase = b - math.floor(b)
        sc, inten, ex = plan(tl, b)
        punch = math.exp(-phase * 6) if b >= DROP_BEAT else 0.0
        hit = tl.hit(t) if b >= DROP_BEAT - 0.5 else 0.0
        # подъём перед дропом: глитч нарастает
        if DROP_BEAT - 0.5 <= b < DROP_BEAT:
            hit = max(hit, (b - (DROP_BEAT - 0.5)) * 2)
            if b > DROP_BEAT - 0.25:
                sc = "static"
        flash = 0.0
        is_down = (int(math.floor(b)) - tl.ph) % 4 == 0
        if b >= DROP_BEAT and (is_down or ex.get("flash")):
            flash = math.exp(-phase * 14) * (0.9 if ex.get("flash") else 0.55)
        if ex.get("strobe"):
            flash = max(flash, math.exp(-((b * 2) % 1) * 22) * 0.3)
        if sc != last_scene:
            prev = None  # жёсткий кат без шлейфа

        if sc == "phone":
            img = scene_phone(A, t, b)
        elif sc == "phone_outro":
            ob = b - (tl.nb - 2)
            img = scene_phone(A, t, ob, outro=True)
            if ob > 1.35:  # в конце — помехи, кадр уходит в статику (луп в начало)
                img = scene_static(A, t, b, 0, text="FLUFFY BARBARA — LONELY")
        elif sc == "street":
            img = scene_street(A, t, b, 0)
        elif sc == "windows":
            img = scene_windows(A, t, b, 0)
        elif sc == "heart":
            sep = 0.15 * punch
            if "break" in ex:
                sep = 0.2 + 2.2 * ex["break"] ** 1.5
            img = scene_heart(A, t, b, 0, sep=sep, punch=punch)
        elif sc == "tunnel":
            img = scene_tunnel(A, t, b, 0, punch=punch)
        elif sc == "type":
            img = scene_type(A, t, b, 0, punch=punch)
        else:
            img = scene_static(A, t, b, 0)
        if ex.get("word"):
            img = word_overlay(img, ex["word"], phase)

        f = post(A, img, t, i, inten, punch, hit, flash, prev, ex)
        prev = f
        last_scene = sc
        frame = (f * 255).astype(np.uint8)
        p.stdin.write(frame.tobytes())
        if preview_dir and i % 15 == 0:
            Image.fromarray(frame).save(os.path.join(preview_dir, f"f{i:03d}.jpg"), quality=80)
        if i % 30 == 0:
            print(f"  frame {i}/{nfr}  t={t:5.2f}s  beat={b:5.2f}  scene={sc}", flush=True)
    p.stdin.close()
    if p.wait() != 0:
        sys.exit("ffmpeg failed")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", help="аудиофайл трека (mp3/wav/m4a…)")
    ap.add_argument("--drop", type=float, help="секунда в треке, где падает дроп (окно начнётся за 4 доли до него)")
    ap.add_argument("--start", type=float, help="или: начало 15-секундного окна")
    ap.add_argument("--bpm", type=float, help="принудительно задать темп")
    ap.add_argument("--no-muffle", action="store_true", help="без глухого интро")
    ap.add_argument("--no-tapestop", action="store_true", help="без tape-stop в конце")
    ap.add_argument("--out", default="lonely_edit.mp4")
    ap.add_argument("--preview", help="папка для превью-кадров")
    a = ap.parse_args()
    rng = np.random.default_rng(42)
    work = os.path.dirname(os.path.abspath(a.out))
    wav = os.path.join(work, "_edit_audio.wav")

    if a.track:
        if a.drop is not None:
            pre = 10.0
            region_start = max(0.0, a.drop - pre)
            y = ffmpeg_load(a.track, region_start, pre + DUR, 22050, 1)
            an = analyze(y, 22050, a.bpm)
            bts = an["beats"] + region_start
            k = int(np.argmin(np.abs(bts - a.drop)))
            per = 60.0 / an["bpm"]
            start = float(bts[k] - DROP_BEAT * per)
            if start < 0:
                print("! дроп слишком близко к началу трека — окно начнётся с 0:00")
                start = 0.0
        else:
            start = float(a.start or 0.0)
        y = ffmpeg_load(a.track, start, DUR, 22050, 1)
        an = analyze(y, 22050, a.bpm)
        stereo = ffmpeg_load(a.track, start, DUR, SR, 2)
        stereo = np.pad(stereo, ((0, max(0, int(DUR * SR) - len(stereo))), (0, 0)))[: int(DUR * SR)]
        print(f"track window: {start:.2f}s → {start + DUR:.2f}s")
    else:
        stereo, bpm = synth_guide()
        an = analyze(stereo.mean(1)[::2].copy(), 22050, None)
        print(f"guide track: true 140 BPM, detected {an['bpm']:.1f} BPM")
        an["beats"] = np.arange(0, DUR, 60 / bpm)   # для гайда берём точную сетку
        an["downbeat_phase"] = 0

    print(f"BPM {an['bpm']:.1f} · beats {len(an['beats'])} · downbeat phase {an['downbeat_phase']} · hits {len(an['hits'])}")
    tl = Timeline(an["beats"], an["downbeat_phase"], an["hits"])
    drop_t = float(np.interp(DROP_BEAT, tl.bi, tl.bt))
    audio = dirty_audio(stereo, drop_t, rng, muffle=not a.no_muffle, tapestop=not a.no_tapestop)
    write_wav(wav, audio)
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
    render(tl, wav, a.out, a.preview)
    os.remove(wav)
    print("done →", a.out)


if __name__ == "__main__":
    main()
