#!/usr/bin/env python3
"""
FLUFFY BARBARA — «НЕ ИЩИ МЕНЯ» · 15s dirty TikTok edit generator.

Сюжет идёт за текстом: она пишет и звонит → «во мне только алкоголь» →
ночная трасса и крутящийся код региона → «абонент недоступен». Караоке-титры по словам.

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
            word = text_rgba("НЕ ИЩИ МЕНЯ · ", FONT_BIG, 150, fill, stroke, sf)
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


def phone_header(d, name, status, status_col=(130, 130, 136)):
    d.rectangle([0, 0, W, 350], fill=(18, 18, 21))
    d.text((40, 290), "‹", font=font(FONT_UI, 52), fill=(200, 200, 205), anchor="lm")
    d.ellipse([86, 252, 162, 328], fill=(60, 60, 66))
    d.text((124, 290), name[:1].upper(), font=font(FONT_UI, 38), fill=(200, 200, 205), anchor="mm")
    d.text((186, 270), name, font=font(FONT_UI, 40), fill=(240, 240, 240), anchor="lm")
    d.text((186, 312), status, font=font(FONT_UI_REG, 26), fill=status_col, anchor="lm")


def bubble(d, txt, y, right=False, col=(40, 40, 46), tcol=(240, 240, 240)):
    f = font(FONT_UI, 40)
    l, tp, r, bt = f.getbbox(txt)
    bw, bh = r - l + 60, 80
    x0 = W - 40 - bw if right else 40
    d.rounded_rectangle([x0, y, x0 + bw, y + bh], radius=38, fill=col)
    d.text((x0 + 32, y + bh / 2), txt, font=f, fill=tcol, anchor="lm")
    return y + bh + 14


def scene_chat(A, t, b):
    """Она пишет — он молчит."""
    img = Image.new("RGB", (W, H), (9, 9, 11))
    d = ImageDraw.Draw(img)
    phone_header(d, "детка", "в сети", (90, 160, 255))
    y = 390
    d.text((W / 2, y), "сегодня 03:07", font=font(FONT_UI_REG, 26), fill=(110, 110, 115), anchor="mm")
    y += 40
    msgs = ["ты где?", "почему не отвечаешь", "ответь мне", "пожалуйста"]
    for k, m in enumerate(msgs):
        if b >= k * 0.85:
            y = bubble(d, m, y)
    if 2.4 <= b < 3.6:
        d.rounded_rectangle([40, y, 200, y + 84], radius=38, fill=(32, 32, 36))
        for k in range(3):
            on = int(t * 8 + k) % 3 == 0
            d.ellipse([74 + k * 36, y + 32, 94 + k * 36, y + 52], fill=(220, 220, 220) if on else (90, 90, 95))
    d.rounded_rectangle([30, H - 380, W - 30, H - 300], radius=40, fill=(22, 22, 25))
    d.text((70, H - 340), "Сообщение", font=font(FONT_UI_REG, 30), fill=(90, 90, 95), anchor="lm")
    osd(img, t)
    return img


def scene_call(A, t, b, punch=0.0):
    """Входящий от «детка» — телефон вибрирует, он сбрасывает."""
    img = Image.new("RGB", (W, H), (12, 12, 14))
    d = ImageDraw.Draw(img)
    dx = int(9 * math.sin(t * 95)) if (t * 2) % 1 < 0.7 else 0
    d.text((W / 2 + dx, 300), "входящий вызов", font=font(FONT_UI_REG, 32), fill=(150, 150, 155), anchor="mm")
    d.ellipse([W / 2 - 110 + dx, 380, W / 2 + 110 + dx, 600], fill=(48, 48, 54))
    d.text((W / 2 + dx, 490), "Д", font=font(FONT_BIG, 110), fill=(210, 210, 215), anchor="mm")
    d.text((W / 2 + dx, 690), "детка", font=font(FONT_BIG, 88), fill=(245, 245, 245), anchor="mm")
    for cx, col, lab in ((190, RED, "Отклонить"), (530, (40, 170, 80), "Ответить")):
        r = 72 * (1 + (0.18 * punch if col == RED else 0))
        d.ellipse([cx - r, 1060 - r, cx + r, 1060 + r], fill=col)
        d.text((cx, 1160), lab, font=font(FONT_UI_REG, 26), fill=(170, 170, 175), anchor="mm")
    return img


def scene_missed(A, t, b):
    img = Image.new("RGB", (W, H), (10, 10, 12))
    d = ImageDraw.Draw(img)
    n = 17 + int(max(0, b - DROP_BEAT) * 2)
    d.text((40, 250), "Недавние", font=font(FONT_BIG, 64), fill=(240, 240, 240), anchor="lm")
    d.text((40, 320), f"пропущенные: {n}", font=font(FONT_UI, 32), fill=RED, anchor="lm")
    rows = min(10, 3 + int((b * 2) % 8))
    for k in range(rows):
        y = 400 + k * 86
        d.line([(40, y + 80), (W - 40, y + 80)], fill=(30, 30, 34), width=2)
        d.text((40, y + 26), f"детка ({n - k})", font=font(FONT_UI, 38), fill=RED, anchor="lm")
        d.text((40, y + 62), "мобильный", font=font(FONT_UI_REG, 24), fill=(110, 110, 115), anchor="lm")
        d.text((W - 40, y + 40), f"03:{7 - k % 8:02d}", font=font(FONT_UI_REG, 28), fill=(120, 120, 125), anchor="rm")
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
    refl = f[1100 - (np.arange(H - 1100) + 1)]
    ripple = (np.sin(np.arange(H - 1100) * 0.6 + t * 9) * 6).astype(int)
    f[1100:] = np.stack([np.roll(refl[i], ripple[i], 0) for i in range(len(refl))]) * 0.35
    f = f * (1 - A.street_mask)
    img = Image.fromarray((np.clip(f, 0, 1) * 255).astype(np.uint8))
    osd(img, t)
    return img


_BOKEH = None


def bokeh():
    global _BOKEH
    if _BOKEH is None:
        rng = np.random.default_rng(11)
        f = np.zeros((H, W, 3), np.float32) + 0.02
        for _ in range(26):
            cx, cy, r = rng.uniform(0, W), rng.uniform(0, H * 0.75), rng.uniform(30, 110)
            col = np.array([1.0, 0.65, 0.3] if rng.random() < 0.7 else [1.0, 0.15, 0.2], np.float32)
            m = np.clip(1.2 - np.sqrt((XX - cx) ** 2 + (YY - cy) ** 2) / r, 0, 1) ** 0.6
            f += m[..., None] * col * rng.uniform(0.08, 0.25)
        _BOKEH = (np.clip(f, 0, 1) * 255).astype(np.uint8)
    return _BOKEH


def scene_glass(A, t, b, punch=0.0):
    """«Во мне теперь только алкоголь»: стакан со льдом, бутылки, бар в расфокусе."""
    img = Image.fromarray(bokeh())
    d = ImageDraw.Draw(img, "RGBA")
    # бутылки
    for x0, x1, top, sc in ((60, 175, 290, 1.0), (560, 655, 380, 0.85)):
        cx = (x0 + x1) / 2
        nw = 22 * sc
        d.rectangle([cx - nw, top, cx + nw, top + 110 * sc], fill=(26, 26, 30, 255))
        d.polygon([(cx - nw, top + 110 * sc), (cx + nw, top + 110 * sc), (x1, top + 200 * sc), (x0, top + 200 * sc)],
                  fill=(26, 26, 30, 255))
        d.rectangle([x0, top + 200 * sc, x1, 860], fill=(26, 26, 30, 255))
        d.line([(x0 + 14, top + 220 * sc), (x0 + 14, 840)], fill=(110, 90, 70, 160), width=5)
        d.rectangle([x0 + 8, top + 380 * sc, x1 - 8, top + 520 * sc], fill=(60, 12, 16, 255))
    # стакан
    gt, gb, tl_, tr_, bl_, br_ = 420, 820, 200, 520, 238, 482

    def xl(y):
        return tl_ + (y - gt) / (gb - gt) * (bl_ - tl_) + 7

    def xr(y):
        return tr_ - (y - gt) / (gb - gt) * (tr_ - br_) - 7

    y0 = 555 + 8 * math.sin(t * 3)
    amp = 5 + 26 * punch
    pts = [(x, y0 + amp * math.sin(x * 0.025 + t * 7)) for x in np.linspace(xl(y0), xr(y0), 30)]
    d.polygon(pts + [(xr(gb - 6), gb - 6), (xl(gb - 6), gb - 6)], fill=(205, 120, 30, 215))
    for k, (ix, ph) in enumerate(((268, 0.0), (355, 1.7), (440, 3.1))):
        cy = y0 - 10 + 10 * math.sin(t * 2.3 + ph) + 14 * punch * (k - 1)
        a = 0.35 * math.sin(t * 1.6 + ph) + k
        s = 44
        sq = [(ix + s * math.cos(a + q * math.pi / 2), cy + s * math.sin(a + q * math.pi / 2)) for q in range(4)]
        d.polygon(sq, fill=(225, 232, 240, 80), outline=(240, 240, 250, 210))
    d.line([(tl_, gt), (bl_, gb), (br_, gb), (tr_, gt)], fill=(215, 215, 220, 255), width=6)
    d.rectangle([bl_ - 4, gb, br_ + 4, gb + 36], fill=(150, 150, 155, 200))
    d.line([(tl_ + 30, gt + 30), (bl_ + 26, gb - 30)], fill=(255, 255, 255, 70), width=10)
    d.rectangle([0, 858, W, H], fill=(14, 10, 8, 255))
    return img


def scene_road(A, t, b, punch=0.0):
    """«Я меняю регион»: ночная трасса от первого лица."""
    img = Image.new("RGB", (W, H), (6, 6, 9))
    d = ImageDraw.Draw(img, "RGBA")
    yh, F = 520, 470
    vx = W / 2 + 40 * math.sin(t * 0.8)
    ph = b - math.floor(b)
    dist = 20 * t + 3.0 * (math.floor(b) + (1 - math.exp(-ph * 5)))

    def P(X, z, h=0.0):
        return vx + X * F / z, yh + (1 - h) * F / z

    for k in range(24):  # небо — едва заметный градиент
        d.rectangle([0, yh - 24 * (k + 1), W, yh - 24 * k], fill=(18 - k // 2, 18 - k // 2, 26 - k // 2, 255))
    d.polygon([P(-1.6, 0.6), P(1.6, 0.6), P(1.6, 80), P(-1.6, 80)], fill=(24, 24, 27, 255))
    # фары: конус
    d.polygon([P(-1.3, 0.6), P(1.3, 0.6), P(0.7, 7), P(-0.7, 7)], fill=(255, 240, 210, 26))
    for X in (-1.5, 1.5):
        d.line([P(X, 0.6), P(X, 80)], fill=(200, 200, 200, 255), width=5)
    for k in range(40):
        z = 2 * k - (dist % 2) + 0.6
        if z < 0.6:
            continue
        a, c = P(0, z), P(0, z + 1)
        w1, w2 = 0.05 * F / z, 0.05 * F / (z + 1)
        d.polygon([(a[0] - w1, a[1]), (a[0] + w1, a[1]), (c[0] + w2, c[1]), (c[0] - w2, c[1])],
                  fill=(225, 225, 225, 255))
    for k in range(12):  # фонари вдоль трассы
        z = 9 * k - (dist % 9) + 0.8
        if z < 0.8:
            continue
        for X in (-3.0, 3.0):
            g, top = P(X, z), P(X, z, 3.2)
            d.line([g, top], fill=(70, 70, 75, 255), width=max(1, int(18 / z)))
            r = max(2, 60 / z)
            d.ellipse([top[0] - r * 2.5, top[1] - r * 2.5, top[0] + r * 2.5, top[1] + r * 2.5], fill=(255, 190, 110, 40))
            d.ellipse([top[0] - r, top[1] - r, top[0] + r, top[1] + r], fill=(255, 220, 160, 255))
    zc = 10 + 2.5 * math.sin(t * 0.7)  # машина впереди — красные стопы
    for sx in (-0.32, 0.32):
        cx, cy = P(0.45 + sx, zc, 0.45)
        r = 0.09 * F / zc
        d.ellipse([cx - r * 3, cy - r * 3, cx + r * 3, cy + r * 3], fill=(255, 20, 30, 60))
        d.ellipse([cx - r, cy - r * 0.6, cx + r, cy + r * 0.6], fill=(255, 40, 40, 255))
    km = 712 + int(t * 7)
    d.text((40, 120), f"М-4 · {km} км", font=font(FONT_MONO, 34), fill=(230, 230, 230))
    d.text((40, 166), f"{142 + int(9 * math.sin(t * 2))} км/ч", font=font(FONT_MONO, 26), fill=(170, 170, 170))
    d.text((W - 40, 120), "геолокация: выкл", font=font(FONT_MONO, 26), fill=RED, anchor="ra")
    return img


REGIONS = ["77", "78", "23", "05", "39", "25", "14", "61", "82", "99", "116", "54"]


def scene_plate(A, t, b, punch=0.0):
    """Номер машины: код региона крутится как барабан."""
    img = Image.new("RGB", (W, H), (20, 20, 23))
    d = ImageDraw.Draw(img, "RGBA")
    for k in range(16):
        c = 20 + k
        d.rectangle([0, 160 + k * 30, W, 190 + k * 30], fill=(c, c, c + 3, 255))
    for cx in (70, W - 70):  # стоп-сигналы
        for g in range(6, 0, -1):
            e = g * 18
            d.rounded_rectangle([cx - 60 - e, 260 - e, cx + 60 + e, 360 + e], radius=20 + e,
                                fill=(255, 20, 30, int(18 + 10 * punch)))
        d.rounded_rectangle([cx - 60, 260, cx + 60, 360], radius=18, fill=(230, 25, 35, 255))
    px, py, pw, ph_ = 40, 560, 640, 150
    d.rounded_rectangle([px, py, px + pw, py + ph_], radius=14, fill=(236, 236, 230, 255), outline=(15, 15, 15, 255), width=6)
    d.text((px + 34, py + ph_ / 2 + 8), "А", font=font(FONT_BIG, 92), fill=(15, 15, 15), anchor="lm")
    d.text((px + 108, py + ph_ / 2 + 2), "777", font=font(FONT_BIG, 118), fill=(15, 15, 15), anchor="lm")
    d.text((px + 330, py + ph_ / 2 + 8), "МР", font=font(FONT_BIG, 92), fill=(15, 15, 15), anchor="lm")
    dv = px + 480
    d.line([(dv, py + 6), (dv, py + ph_ - 6)], fill=(15, 15, 15, 255), width=5)
    # барабан региона
    k = int(b * 2)
    p = (b * 2) % 1
    s = 1 - math.exp(-p * 14)
    box = Image.new("RGBA", (px + pw - dv - 12, 100), (236, 236, 230, 255))
    bd = ImageDraw.Draw(box)
    for code, off in ((REGIONS[(k - 1) % len(REGIONS)], -s), (REGIONS[k % len(REGIONS)], 1 - s)):
        bd.text((box.width / 2, 50 + off * 100), code, font=font(FONT_BIG, 76 if len(code) < 3 else 62),
                fill=(15, 15, 15), anchor="mm")
    img.paste(box, (dv + 6, py + 6), box)
    d.text((dv + 30, py + ph_ - 26), "RUS", font=font(FONT_UI, 26), fill=(15, 15, 15), anchor="lm")
    fx = dv + 100
    for j, col in enumerate(((245, 245, 245), (30, 70, 200), (215, 30, 40))):
        d.rectangle([fx, py + ph_ - 38 + j * 8, fx + 34, py + ph_ - 30 + j * 8], fill=col + (255,))
    return img


def scene_unavail(A, t, b):
    img = Image.new("RGB", (W, H), (8, 8, 10))
    d = ImageDraw.Draw(img)
    d.text((W / 2, 300), "он", font=font(FONT_BIG, 70), fill=(235, 235, 235), anchor="mm")
    d.text((W / 2, 370), "вызов…" if b < 0.8 else "вызов завершён", font=font(FONT_UI_REG, 30),
           fill=(140, 140, 145), anchor="mm")
    if b >= 0.8:
        d.text((W / 2, 520), "Абонент временно", font=font(FONT_UI, 46), fill=(245, 245, 245), anchor="mm")
        d.text((W / 2, 578), "недоступен", font=font(FONT_UI, 46), fill=(245, 245, 245), anchor="mm")
        d.text((W / 2, 640), "или находится вне зоны действия сети", font=font(FONT_UI_REG, 26),
               fill=(130, 130, 135), anchor="mm")
    d.ellipse([W / 2 - 72, 1000, W / 2 + 72, 1144], fill=RED)
    osd(img, t)
    return img


def scene_static(A, t, b, k, text="NO SIGNAL", size=58):
    i = int(t * FPS)
    f = A.static[i % len(A.static)] * 0.85
    f = np.repeat(f, 3, 2)
    bar_y = int((t * 900) % (H + 300)) - 150
    lo, hi = max(0, bar_y), min(H, bar_y + 140)
    if hi > lo:
        f[lo:hi] = np.clip(f[lo:hi] * 1.5 + 0.2, 0, 1)
    img = Image.fromarray((f * 255).astype(np.uint8))
    if text:
        lines = text.split("\n")
        for j, ln in enumerate(lines):
            y = H * 0.42 + (j - (len(lines) - 1) / 2) * (size * 1.5)
            txt = text_rgba(ln, FONT_MONO, size, (240, 240, 240) if j == 0 else RED)
            bg = Image.new("RGBA", (txt.width + 40, txt.height + 24), (0, 0, 0, 255))
            paste_c(img, bg, W / 2, y)
            paste_c(img, txt, W / 2, y)
    return img


def scene_type(A, t, b, k, punch=0.0):
    f = np.zeros((H, W, 3), np.float32)
    rh = A.rows[0].shape[0]
    gap = 6
    total = len(A.rows) * (rh + gap)
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


# ═════════════════════════════ LYRICS ═════════════════════════════
# Тайминг в долях от начала окна (дроп = доля 4). Пустая строка = новый титр.
DEFAULT_LYRICS = """
0 НЕ
0.5 ИЩИ
1 МЕНЯ,
2 ДЕТКА

4 Я
4.5 ДАВНО
5.25 УЖЕ
6 НЕ
6.5 ТВОЙ

8 НЕ
8.5 ИЩИ
9 МЕНЯ,

10 ВО
10.5 МНЕ
11 ТЕПЕРЬ
12 ТОЛЬКО
13 АЛКОГОЛЬ

15.75 ТЫ
16 НЕ
16.5 ИЩИ
17 МЕНЯ,
18 ДЕТКА

20 Я
20.5 МЕНЯЮ
22 РЕГИОН

24 НЕ
24.5 ИЩИ
25 МЕНЯ,
26 ДЕТКА

28 НЕ
28.5 ИЩИ
29.5 МЕНЯ
"""


def parse_lyrics(text):
    chunks, cur = [], []
    for ln in text.strip("\n").split("\n"):
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            if cur:
                chunks.append(cur)
                cur = []
            continue
        tm, word = ln.split(None, 1)
        cur.append((float(tm), word.upper()))
    if cur:
        chunks.append(cur)
    return chunks


_band = np.clip(1 - np.abs(np.arange(H) - H * 0.725) / 190, 0, 1) ** 0.8 * 120
CAP_BAND = Image.fromarray(np.dstack([np.zeros((H, W, 3), np.uint8),
                                      np.repeat(_band[:, None], W, 1).astype(np.uint8)]), "RGBA")


def caption(img, chunks, b):
    """Караоке-титр: слова появляются по одному, текущее — красное с «попом»."""
    cur = None
    for j, ch in enumerate(chunks):
        nxt = chunks[j + 1][0][0] if j + 1 < len(chunks) else 1e9
        if ch[0][0] - 0.02 <= b < min(nxt, ch[-1][0] + 3):
            cur = ch
    if not cur:
        return img
    shown = [(tb, w) for tb, w in cur if tb - 0.02 <= b]
    size = 84
    space = 22
    imgs = []
    for k, (tb, w) in enumerate(shown):
        last = k == len(shown) - 1
        im = text_rgba(w, FONT_BIG, size, RED if last else (250, 250, 250), 7, (0, 0, 0))
        sc = 1 + 0.35 * math.exp(-(b - tb) * 9) if last else 1.0
        imgs.append((im, sc))
    rows, row, rw = [], [], 0
    for im, sc in imgs:
        if row and rw + space + im.width > W - 70:
            rows.append(row)
            row, rw = [], 0
        rw += (space if row else 0) + im.width
        row.append((im, sc))
    rows.append(row)
    lh = size * 1.12
    img.paste(CAP_BAND, (0, 0), CAP_BAND)
    y0 = H * 0.725 - (len(rows) - 1) * lh / 2
    for r, row in enumerate(rows):
        tw = sum(im.width for im, _ in row) + space * (len(row) - 1)
        x = W / 2 - tw / 2
        for im, sc in row:
            paste_c(img, im, x + im.width / 2, y0 + r * lh, sc)
            x += im.width + space
    return img


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
    """→ (scene, intensity, extra) для позиции b (в долях). Сцены идут за текстом."""
    D, N = DROP_BEAT, tl.nb
    if b >= max(N - 3, 30):
        return "unavail", 0.3, {}
    if b < D:                                   # «не ищи меня, детка» — она пишет
        return "chat", 0.25, {}
    if b < D + 1:                               # ДРОП
        return "type", 1.0, {"flash": True}
    if b < 8:                                   # «я давно уже не твой»
        return ["call", "street", "missed"][int(b - 5) % 3], 0.8, {}
    if b < 9:
        return "type", 0.9, {"flash": True}
    if b < 16:                                  # «во мне теперь только алкоголь»
        seq = ["glass", "glass", "street", "glass", "glass", "missed", "glass"]
        return seq[int(b - 9) % len(seq)], 0.6, {"drunk": True}
    if b < 20:                                  # «я меняю регион»
        return ("road" if b < 18 else "plate"), 0.75, {}
    if b < 24:
        seq = ["road", "plate", "type", "road", "plate", "street", "road", "plate"]
        return seq[int((b - 20) * 2) % len(seq)], 1.0, {"strobe": True}
    if b < 28:                                  # «не ищи меня, детка»
        return ["type", "street", "call", "missed"][int(b - 24) % 4], 0.8, {"flash": b < 25}
    seq = ["street", "plate", "glass", "type", "road", "call", "missed", "street"]
    return seq[int((b - 28) * 2) % len(seq)], 1.0, {"strobe": True}


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
    if extra.get("drunk"):  # «пьяная» волна + двоение
        ys = np.arange(H)
        sh = (14 * np.sin(ys * 0.012 + t * 3.1) + 8 * np.sin(ys * 0.031 - t * 5)).astype(int)
        f = f[ys[:, None], (np.arange(W)[None, :] - sh[:, None]) % W]
        f = np.maximum(f, np.roll(f, int(18 + 10 * math.sin(t * 2.2)), 1) * 0.55)
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


# ═════════════════════════════ RENDER ═════════════════════════════
def render(tl, wav_path, out_path, chunks, preview_dir=None):
    A = Assets()
    nfr = int(DUR * FPS)
    vf = f"scale={OUT_W}:{OUT_H}:flags=bicubic,format=yuv420p"
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
           "-i", "-", "-i", wav_path, "-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "18",
           "-maxrate", "28M", "-bufsize", "56M", "-profile:v", "high", "-r", str(FPS),
           "-c:a", "aac", "-b:a", "256k", "-ar", str(SR), "-shortest", "-movflags", "+faststart", out_path]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    prev = None
    last_scene = None
    out_beat = max(tl.nb - 3, 30)
    for i in range(nfr):
        t = i / FPS
        b = tl.beat(t)
        phase = b - math.floor(b)
        sc, inten, ex = plan(tl, b)
        punch = math.exp(-phase * 6) if DROP_BEAT <= b < out_beat else 0.0
        hit = tl.hit(t) if DROP_BEAT - 0.5 <= b < out_beat else 0.0
        if DROP_BEAT - 0.5 <= b < DROP_BEAT:      # разгон перед дропом
            hit = max(hit, (b - (DROP_BEAT - 0.5)) * 2)
            if b > DROP_BEAT - 0.25:
                sc = "static"
        flash = 0.0
        is_down = (int(math.floor(b)) - tl.ph) % 4 == 0
        if DROP_BEAT <= b < out_beat and (is_down or ex.get("flash")):
            flash = math.exp(-phase * 14) * (0.9 if ex.get("flash") else 0.55)
        if ex.get("strobe"):
            flash = max(flash, math.exp(-((b * 2) % 1) * 22) * 0.3)
        if sc != last_scene:
            prev = None

        show_caption = True
        if sc == "chat":
            img = scene_chat(A, t, b)
        elif sc == "unavail":
            ob = b - out_beat
            img = scene_unavail(A, t, ob)
            if t > DUR - 0.35:          # хвост уходит в статику → луп в начало
                img = scene_static(A, t, b, 0, text="FLUFFY BARBARA\nНЕ ИЩИ МЕНЯ", size=46)
                show_caption = False
        elif sc == "call":
            img = scene_call(A, t, b, punch)
        elif sc == "missed":
            img = scene_missed(A, t, b)
        elif sc == "street":
            img = scene_street(A, t, b, 0)
        elif sc == "glass":
            img = scene_glass(A, t, b, punch)
        elif sc == "road":
            img = scene_road(A, t, b, punch)
        elif sc == "plate":
            img = scene_plate(A, t, b, punch)
        elif sc == "type":
            img = scene_type(A, t, b, 0, punch=punch)
        else:
            img = scene_static(A, t, b, 0)
        if show_caption:
            img = caption(img, chunks, b)

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
    ap.add_argument("--lyrics", help="файл тайминга текста: строки «<время> <слово>», пустая строка = новый титр")
    ap.add_argument("--lyrics-unit", choices=["beat", "sec"], default="beat",
                    help="время в файле текста: доли (по умолчанию) или секунды от начала окна")
    ap.add_argument("--no-muffle", action="store_true", help="без глухого интро")
    ap.add_argument("--no-tapestop", action="store_true", help="без tape-stop в конце")
    ap.add_argument("--out", default="ne_ishchi_menya_edit.mp4")
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
        an["beats"] = np.arange(0, DUR, 60 / bpm)
        an["downbeat_phase"] = 0

    print(f"BPM {an['bpm']:.1f} · beats {len(an['beats'])} · downbeat phase {an['downbeat_phase']} · hits {len(an['hits'])}")
    tl = Timeline(an["beats"], an["downbeat_phase"], an["hits"])
    chunks = parse_lyrics(open(a.lyrics, encoding="utf8").read() if a.lyrics else DEFAULT_LYRICS)
    if a.lyrics_unit == "sec":
        chunks = [[(tl.beat(tm), w) for tm, w in ch] for ch in chunks]
    drop_t = float(np.interp(DROP_BEAT, tl.bi, tl.bt))
    audio = dirty_audio(stereo, drop_t, rng, muffle=not a.no_muffle, tapestop=not a.no_tapestop)
    write_wav(wav, audio)
    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
    render(tl, wav, a.out, chunks, a.preview)
    os.remove(wav)
    print("done →", a.out)


if __name__ == "__main__":
    main()
