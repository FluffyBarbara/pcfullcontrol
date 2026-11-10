'use strict';
// Удалённое управление: картинка экрана для телефона и ввод мыши/клавиатуры.
// Windows: постоянный помощник ввода (PowerShell + user32 SendInput), чтобы клики шли без задержек.
// Linux: через xdotool (если установлен).
const { spawn } = require('child_process');
const { IS_WIN, run, which, PS_EXE, secureBinDir } = require('./system/exec');

const electron = () => require('electron');

// Виртуальные клавиши Windows
const VK = {
  enter: 0x0D, esc: 0x1B, tab: 0x09, backspace: 0x08, delete: 0x2E, insert: 0x2D, space: 0x20,
  ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5B, menu: 0x5D, caps: 0x14,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, home: 0x24, end: 0x23, pgup: 0x21, pgdn: 0x22,
  printscreen: 0x2C, volup: 0xAF, voldown: 0xAE, mute: 0xAD,
};
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6F + i;
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c + 32)] = c;
for (let d = 0; d <= 9; d++) VK[String(d)] = 0x30 + d;
const EXTENDED = new Set([0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2D, 0x2E, 0x5B, 0x5D, 0x2C]);

// xdotool-имена клавиш для Linux
const XDO = {
  enter: 'Return', esc: 'Escape', tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', insert: 'Insert', space: 'space',
  ctrl: 'ctrl', alt: 'alt', shift: 'shift', win: 'super', left: 'Left', up: 'Up', right: 'Right', down: 'Down',
  home: 'Home', end: 'End', pgup: 'Prior', pgdn: 'Next', printscreen: 'Print',
};

const AGENT_CS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PccInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool SetThreadDesktop(IntPtr desk);
  public static void Init() { SetProcessDPIAware(); }
  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(uint flags, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void MoveBy(int dx, int dy) { POINT p; if (GetCursorPos(out p)) SetCursorPos(p.X + dx, p.Y + dy); }
  public static void Button(string b, bool down) {
    uint f = b == "right" ? (down ? 0x0008u : 0x0010u) : b == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u);
    Send(Mouse(f, 0));
  }
  public static void Wheel(int dy, int dx) {
    if (dy != 0) Send(Mouse(0x0800, unchecked((uint)dy)));
    if (dx != 0) Send(Mouse(0x01000, unchecked((uint)dx)));
  }
  public static void KeyEvent(int vk, bool down, bool ext) {
    uint f = (down ? 0u : 0x0002u) | (ext ? 0x0001u : 0u);
    Send(Key((ushort)vk, 0, f));
  }
  public static void Text(string s) {
    foreach (char c in s) {
      if (c == '\\n') { KeyEvent(0x0D, true, false); KeyEvent(0x0D, false, false); continue; }
      Send(Key(0, (ushort)c, 0x0004)); Send(Key(0, (ushort)c, 0x0004 | 0x0002));
    }
  }
}`;

// Помощник читает команды построчно: m x y | r dx dy | d btn | u btn | w dy dx | k vk 1/0 ext | t base64
// Помощник компилируется один раз в DLL (папка данных программы) — дальше загружается за секунду
const AGENT_PS = `
$dll = $env:PCFC_AGENT_DLL
$loaded = $false
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll; $loaded = $true } catch {} }
if (-not $loaded) {
  $src = @'
${AGENT_CS}
'@
  if ($dll) {
    try { New-Item -ItemType Directory -Force -Path (Split-Path $dll) | Out-Null; Add-Type -TypeDefinition $src -OutputAssembly $dll; Add-Type -Path $dll; $loaded = $true } catch {}
  }
  if (-not $loaded) { Add-Type -TypeDefinition $src }
}
[PccInput]::Init()
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'm' { [PccInput]::Move([int]$p[1], [int]$p[2]) }
      'r' { [PccInput]::MoveBy([int]$p[1], [int]$p[2]) }
      'd' { [PccInput]::Button($p[1], $true) }
      'u' { [PccInput]::Button($p[1], $false) }
      'w' { [PccInput]::Wheel([int]$p[1], [int]$p[2]) }
      'k' { [PccInput]::KeyEvent([int]$p[1], $p[2] -eq '1', $p[3] -eq '1') }
      't' { [PccInput]::Text([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
    }
  } catch { [Console]::Out.WriteLine('error ' + $_.Exception.Message) }
}`;

class RemoteControl {
  constructor(ctx) {
    this.ctx = ctx;
    this.agent = null;
    this.agentReady = null;
    this.idleTimer = null;
    this.sessions = new Map(); // deviceId -> время последнего кадра
  }

  get enabled() { return this.ctx.config.mobile.remoteControl !== false; }

  // ---------------- экраны ----------------
  displays() {
    const { screen } = electron();
    return screen.getAllDisplays().map((d, i) => {
      const phys = IS_WIN && screen.dipToScreenRect ? screen.dipToScreenRect(null, d.bounds) : {
        x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor),
        width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor),
      };
      return { index: i + 1, id: String(d.id), bounds: d.bounds, phys, primary: d.id === screen.getPrimaryDisplay().id };
    });
  }

  display(index) {
    const ds = this.displays();
    return ds[(Number(index) || 1) - 1] || ds.find((d) => d.primary) || ds[0];
  }

  /** Кадр экрана в JPEG + положение курсора (0..1) на этом экране. */
  async frame(index = 1, width = 1280, quality = 60, deviceName = '') {
    if (!this.enabled) throw new Error('Удалённое управление выключено в настройках программы');
    const { desktopCapturer, screen } = electron();
    const d = this.display(index);
    const w = Math.max(320, Math.min(Number(width) || 1280, d.phys.width));
    const h = Math.round((w * d.phys.height) / d.phys.width);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: w, height: h } });
    const src = sources.find((s) => s.display_id === d.id) || sources[d.index - 1] || sources[0];
    if (!src) throw new Error('Не удалось получить изображение экрана');
    const jpeg = src.thumbnail.toJPEG(Math.max(20, Math.min(Number(quality) || 60, 90)));
    const c = screen.getCursorScreenPoint();
    const b = d.bounds;
    const cursor = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height
      ? { x: (c.x - b.x) / b.width, y: (c.y - b.y) / b.height } : null;
    this.noteSession(deviceName);
    return { jpeg, cursor, width: w, height: h };
  }

  noteSession(deviceName) {
    const key = deviceName || 'телефон';
    const last = this.sessions.get(key) || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      const { E } = require('./telegram-api');
      this.ctx.notifier.notify(`📺 Удалённое управление: <b>${E(key)}</b> подключился к экрану`, { category: 'security', level: 'warning' });
    }
    this.sessions.set(key, Date.now());
  }

  // ---------------- ввод ----------------
  async ensureAgent() {
    if (this.agent && !this.agent.killed && this.agent.exitCode === null) {
      // Уже готов — сразу; ещё запускается — ждём тот же запуск
      if (this.agentIsReady) return undefined;
      return this.agentReady;
    }
    this.agentIsReady = false;
    const encoded = Buffer.from("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n" + AGENT_PS, 'utf16le').toString('base64');
    const crypto = require('crypto');
    const path = require('path');
    const tag = crypto.createHash('sha1').update(AGENT_CS).digest('hex').slice(0, 10);
    const dll = this.ctx.dataDir ? path.join(secureBinDir(this.ctx.dataDir), `PccInput-${tag}.dll`) : '';
    const p = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PCFC_AGENT_DLL: dll },
    });
    this.agent = p;
    this.agentReady = new Promise((resolve, reject) => {
      // На медленном или занятом компьютере первая компиляция может идти долго — ждём до минуты
      const timer = setTimeout(() => { reject(new Error('Помощник ввода не запустился')); try { p.kill(); } catch (e) { /* ignore */ } }, 60000);
      p.stdout.on('data', (d) => { if (String(d).includes('ready')) { clearTimeout(timer); this.agentIsReady = true; resolve(); } });
      p.on('exit', () => { clearTimeout(timer); reject(new Error('Помощник ввода завершился')); });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    p.on('exit', () => { if (this.agent === p) { this.agent = null; this.agentIsReady = false; } });
    p.stderr.on('data', () => {});
    return this.agentReady;
  }

  async send(lines) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopAgent(), 10 * 60 * 1000);
    await this.ensureAgent();
    this.agent.stdin.write(lines.join('\n') + '\n');
  }

  /** Готов ли помощник ввода (первое касание пройдёт без задержки). */
  get inputReady() { return !IS_WIN || !!(this.agent && this.agentIsReady); }

  /** Заранее запускает помощник ввода, чтобы первое касание на телефоне не ждало его старта. */
  warm() {
    if (!IS_WIN || !this.enabled) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stopAgent(), 10 * 60 * 1000);
    this.ensureAgent().catch(() => {});
  }

  stopAgent() {
    if (this.agent) { try { this.agent.kill(); } catch (e) { /* ignore */ } }
    this.agent = null;
  }

  point(index, nx, ny) {
    const d = this.display(index);
    const x = Math.round(d.phys.x + Math.max(0, Math.min(1, Number(nx))) * (d.phys.width - 1));
    const y = Math.round(d.phys.y + Math.max(0, Math.min(1, Number(ny))) * (d.phys.height - 1));
    return { x, y };
  }

  /** Разбирает «ctrl+shift+esc» в список кодов клавиш. */
  static combo(spec) {
    const keys = String(spec || '').toLowerCase().split('+').map((k) => k.trim()).filter(Boolean);
    return keys.map((k) => {
      if (!(k in VK)) throw new Error(`Неизвестная клавиша: ${k}`);
      return k;
    });
  }

  /**
   * Команда с телефона:
   *  { type: 'move'|'click'|'down'|'up', x, y, button, double }   — координаты 0..1 на выбранном экране
   *  { type: 'rel', dx, dy }  — сдвиг курсора в пикселях (режим тачпада)
   *  { type: 'wheel', dy, dx }  { type: 'key', keys: 'ctrl+c' }  { type: 'text', text }
   */
  async input(cmd, index = 1) {
    if (!this.enabled) throw new Error('Удалённое управление выключено в настройках программы');
    if (!IS_WIN) return this.inputLinux(cmd, index);
    const lines = [];
    const btn = ['left', 'right', 'middle'].includes(cmd.button) ? cmd.button : 'left';
    if (cmd.x !== undefined && cmd.y !== undefined) {
      const p = this.point(index, cmd.x, cmd.y);
      lines.push(`m ${p.x} ${p.y}`);
    }
    switch (cmd.type) {
      case 'move': break;
      case 'rel': {
        const dx = Math.max(-4000, Math.min(4000, Math.round(Number(cmd.dx) || 0)));
        const dy = Math.max(-4000, Math.min(4000, Math.round(Number(cmd.dy) || 0)));
        if (dx || dy) lines.push(`r ${dx} ${dy}`);
        break;
      }
      case 'click':
        for (let i = 0; i < (cmd.double ? 2 : 1); i++) lines.push(`d ${btn}`, `u ${btn}`);
        break;
      case 'down': lines.push(`d ${btn}`); break;
      case 'up': lines.push(`u ${btn}`); break;
      case 'wheel': lines.push(`w ${Math.round(Number(cmd.dy) || 0)} ${Math.round(Number(cmd.dx) || 0)}`); break;
      case 'key': {
        const keys = RemoteControl.combo(cmd.keys);
        for (const k of keys) lines.push(`k ${VK[k]} 1 ${EXTENDED.has(VK[k]) ? 1 : 0}`);
        for (const k of [...keys].reverse()) lines.push(`k ${VK[k]} 0 ${EXTENDED.has(VK[k]) ? 1 : 0}`);
        break;
      }
      case 'text': {
        const text = String(cmd.text || '').slice(0, 2000);
        if (text) lines.push(`t ${Buffer.from(text, 'utf8').toString('base64')}`);
        break;
      }
      default: throw new Error('Неизвестная команда');
    }
    if (lines.length) await this.send(lines);
    return { ok: true };
  }

  async inputLinux(cmd, index) {
    if (!(await which('xdotool'))) throw new Error('Для управления в Linux установите xdotool');
    const args = [];
    if (cmd.x !== undefined && cmd.y !== undefined) {
      const p = this.point(index, cmd.x, cmd.y);
      args.push('mousemove', String(p.x), String(p.y));
    }
    const b = { left: '1', middle: '2', right: '3' }[cmd.button] || '1';
    if (cmd.type === 'rel') args.push('mousemove_relative', '--', String(Math.round(Number(cmd.dx) || 0)), String(Math.round(Number(cmd.dy) || 0)));
    else if (cmd.type === 'click') args.push('click', '--repeat', cmd.double ? '2' : '1', b);
    else if (cmd.type === 'down') args.push('mousedown', b);
    else if (cmd.type === 'up') args.push('mouseup', b);
    else if (cmd.type === 'wheel') {
      const n = Math.max(1, Math.round(Math.abs(Number(cmd.dy) || 0) / 120));
      args.push('click', '--repeat', String(n), Number(cmd.dy) > 0 ? '4' : '5');
    } else if (cmd.type === 'key') args.push('key', RemoteControl.combo(cmd.keys).map((k) => XDO[k] || k).join('+'));
    else if (cmd.type === 'text') args.push('type', '--', String(cmd.text || ''));
    if (args.length) await run('xdotool', args, { timeout: 10000 });
    return { ok: true };
  }
}

module.exports = { RemoteControl, VK };
