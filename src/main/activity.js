'use strict';
// Учёт времени в программах: раз в минуту — какая программа на переднем плане и был ли человек за компьютером.
// Время простоя (больше 5 минут без мыши и клавиатуры) не засчитывается. Всё хранится только локально.
const { spawn } = require('child_process');
const { IS_WIN, PS_EXE } = require('./system/exec');

const AGENT = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Text;
public static class PccFg {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
  static Dictionary<string, string> desc = new Dictionary<string, string>();
  static string PathOf(uint pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return "";
    try { StringBuilder sb = new StringBuilder(1024); uint n = 1024; return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; } finally { CloseHandle(h); }
  }
  static string DescOf(string path) {
    if (String.IsNullOrEmpty(path)) return "";
    string d;
    if (desc.TryGetValue(path, out d)) return d;
    try { FileVersionInfo v = FileVersionInfo.GetVersionInfo(path); d = !String.IsNullOrEmpty(v.ProductName) && v.ProductName.Length < 60 ? v.ProductName : (v.FileDescription ?? ""); } catch { d = ""; }
    desc[path] = d;
    return d;
  }
  public static string Sample() {
    string name = "", path = "", d = "";
    int full = 0;
    try {
      IntPtr w = GetForegroundWindow();
      uint pid; GetWindowThreadProcessId(w, out pid);
      if (pid != 0) {
        name = Process.GetProcessById((int)pid).ProcessName;
        path = PathOf(pid);
        d = DescOf(path);
        RECT r; MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
        if (GetWindowRect(w, out r) && GetMonitorInfo(MonitorFromWindow(w, 2), ref mi))
          full = (r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B) ? 1 : 0;
      }
    } catch {}
    LASTINPUTINFO li = new LASTINPUTINFO(); li.cbSize = (uint)Marshal.SizeOf(li);
    GetLastInputInfo(ref li);
    uint idle = ((uint)Environment.TickCount - li.dwTime) / 1000;
    return name + "|" + idle + "|" + path + "|" + full + "|" + d.Replace("|", " ");
  }
}
'@
while ($true) { [Console]::Out.WriteLine([PccFg]::Sample()); Start-Sleep -Seconds 15 }`;

const STEP = 15; // секунд между замерами

// Папки, где лежат игры (Steam, Epic, GOG, Riot, Ubisoft, EA, Battle.net, Xbox, Wargaming, «Games»)
const GAME_DIRS = /\\(steamapps\\common|epic games|gog games|gog galaxy\\games|riot games|ubisoft game launcher\\games|ea games|origin games|battle\.net|blizzard entertainment|xboxgames|wargaming\.net|lesta|games|игры)\\/i;
const KNOWN_GAMES = /^(robloxplayerbeta|league of legends|valorant-win64-shipping|cs2|csgo|dota2|gta5|gtav|rdr2|fortniteclient-win64-shipping|r5apex|overwatch|minecraft|javaw|witcher3|cyberpunk2077|eldenring|bg3|bg3_dx11|worldoftanks|tarkov|escapefromtarkov|pubg|tslgame|rainbowsix|destiny2|warframe\.x64|rocketleague|fallguys_client|genshinimpact|starrail|hogwartslegacy|palworld-win64-shipping|helldivers2|deadlock|marvel-win64-shipping)$/i;
// Не игры, даже во весь экран: браузеры, видео, лаунчеры, рабочие программы
const NOT_GAMES = /^(chrome|msedge|firefox|opera|opera_gx|browser|brave|vivaldi|yandex|vlc|potplayermini64|potplayermini|mpc-hc64|mpc-be64|wmplayer|video\.ui|microsoft\.media\.player|music\.ui|spotify|aimp|obs64|obs32|discord|telegram|steam|steamwebhelper|epicgameslauncher|galaxyclient|riotclientservices|battle\.net|eadesktop|ubisoftconnect|explorer|powerpnt|winword|excel|code|devenv|mstsc|vmware|virtualbox|zoom|teams|ms-teams|pcfullcontrol)$/i;

function isGameSample({ name, path, full }, fps = 0) {
  if (!name || NOT_GAMES.test(name)) return false;
  if (KNOWN_GAMES.test(name) || GAME_DIRS.test(path || '')) return true;
  return !!full && fps >= 25; // полноэкранная программа, которая рисует кадры, — почти наверняка игра
}

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
    if (!IS_WIN || this.proc || this.viaHelper) return;
    // Лёгкий помощник вместо PowerShell (~5 МБ вместо ~35 МБ)
    const h = this.ctx.helper;
    if (h && h.available) {
      this.viaHelper = (line) => this.onSample(line);
      h.on('activity', this.viaHelper);
      h.use('activity');
      return;
    }
    const encoded = Buffer.from("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n" + AGENT, 'utf16le').toString('base64');
    const p = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
    const [name, idleStr, path = '', fullStr = '0', desc = ''] = line.split('|');
    const idle = Number(idleStr) || 0;
    const full = fullStr === '1';
    const day = localDay();
    if (idle <= 300 && !SKIP.test(name || '')) {
      try { this.ctx.db.addAppUsage(day, name, STEP); } catch (e) { /* база закрыта */ }
    }
    this.trackGame({ name, path, full, desc, idle }, day);
  }

  /**
   * Игры: время и средний FPS. В игре мышь и клавиатура могут не трогаться (геймпад) — поэтому
   * простой здесь не учитывается до 30 минут. FPS меряет PresentMon, пока игра на переднем плане.
   */
  trackGame(smp, day) {
    const fpsMon = this.ctx.fps;
    if (!smp.name || smp.idle > 1800) return;
    const maybe = !NOT_GAMES.test(smp.name) && (smp.full || KNOWN_GAMES.test(smp.name) || GAME_DIRS.test(smp.path));
    if (!maybe) return;
    if (fpsMon && fpsMon.available) fpsMon.touch();
    const cur = fpsMon && fpsMon.available ? fpsMon.current().find((f) => f.app.toLowerCase() === `${smp.name.toLowerCase()}.exe`) : null;
    const fps = cur ? cur.fps : 0;
    if (!isGameSample(smp, fps)) return;
    const title = gameTitle(smp);
    try { this.ctx.db.addGameUsage(day, smp.name, title, STEP, fps > 0 && fps < 1000 ? fps : null); } catch (e) { /* база закрыта */ }
    this.lastGame = { name: smp.name, title, ts: Date.now(), fps };
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
    if (this.viaHelper) { this.ctx.helper.off('activity', this.viaHelper); this.viaHelper = null; }
  }
}

/** Название игры: из сведений о файле (ProductName), иначе — по папке игры или имени файла. */
function gameTitle({ name, path, desc }) {
  const d = String(desc || '').trim();
  if (d && !/^(unreal engine|unity|ue4|ue5|game|launcher|application|bootstrap|java\(tm\) platform se binary)/i.test(d)) return d;
  const m = /\\(?:steamapps\\common|epic games|gog games|riot games|games|игры)\\([^\\]+)/i.exec(path || '');
  if (m) return m[1];
  return niceName(name).replace(/-win64-shipping$/i, '');
}

module.exports = { ActivityTracker, niceName, localDay, isGameSample, gameTitle, GAME_DIRS };
