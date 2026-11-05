'use strict';
// Учёт времени в программах: раз в минуту — какая программа на переднем плане и был ли человек за компьютером.
// Время простоя (больше 5 минут без мыши и клавиатуры) не засчитывается. Всё хранится только локально.
const { spawn } = require('child_process');
const { IS_WIN } = require('./system/exec');

const AGENT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;
public static class PccFg {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  public static string Sample() {
    string name = "";
    try {
      uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      if (pid != 0) name = Process.GetProcessById((int)pid).ProcessName;
    } catch {}
    var li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(li);
    GetLastInputInfo(ref li);
    uint idle = ((uint)Environment.TickCount - li.dwTime) / 1000;
    return name + "|" + idle;
  }
}
'@
while ($true) { [Console]::Out.WriteLine([PccFg]::Sample()); Start-Sleep -Seconds 60 }`;

// Системные окна, которые не считаются «программами»
const SKIP = /^(|idle|explorer|lockapp|logonui|searchhost|searchapp|shellexperiencehost|startmenuexperiencehost|textinputhost|applicationframehost|pcfullcontrol)$/i;

const NICE = {
  chrome: 'Google Chrome', msedge: 'Microsoft Edge', firefox: 'Firefox', opera: 'Opera', browser: 'Яндекс Браузер', telegram: 'Telegram',
  discord: 'Discord', steam: 'Steam', code: 'VS Code', winword: 'Word', excel: 'Excel', powerpnt: 'PowerPoint', spotify: 'Spotify',
  vlc: 'VLC', obs64: 'OBS Studio', notepad: 'Блокнот', cmd: 'Командная строка', windowsterminal: 'Терминал', explorer: 'Проводник',
};
const niceName = (n) => NICE[String(n).toLowerCase()] || n;
const pad = (x) => String(x).padStart(2, '0');
/** Дата по местному времени в виде 2026-11-05. */
function localDay(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

class ActivityTracker {
  constructor(ctx) {
    this.ctx = ctx;
    this.proc = null;
    this.restarts = 0;
  }

  start() {
    if (!IS_WIN || this.proc) return;
    const encoded = Buffer.from("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n" + AGENT, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        this.onSample(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.restarts++ < 20) setTimeout(() => this.start(), 60000);
    });
    p.on('error', () => { this.proc = null; });
  }

  onSample(line) {
    const [name, idleStr] = line.split('|');
    const idle = Number(idleStr) || 0;
    if (idle > 300 || SKIP.test(name || '')) return;
    const day = localDay();
    try { this.ctx.db.addAppUsage(day, name, 60); } catch (e) { /* база закрыта */ }
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
  }
}

module.exports = { ActivityTracker, niceName, localDay };
