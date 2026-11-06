'use strict';
// «Музыка и звук»: что сейчас играет на ПК (любой плеер, сообщающий Windows о воспроизведении:
// Spotify, Яндекс Музыка, браузеры с YouTube/VK, «Медиаплеер», AIMP, VLC…) — название, исполнитель,
// альбом, обложка, позиция, в какой программе и каком окне. Плюс микшер громкости по программам.
// Windows: GlobalSystemMediaTransportControls (WinRT) и Core Audio (сеансы звука) в постоянном помощнике.
const crypto = require('crypto');
const { IS_WIN } = require('./exec');
const { PsAgent } = require('./ps-agent');
const { findCover } = require('./covers');

const CS = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PccMixNs {
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr p);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr p);
  [PreserveSig] int GetChannelCount(out uint c);
  [PreserveSig] int SetMasterVolumeLevel(float db, ref Guid ctx);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  [PreserveSig] int GetMasterVolumeLevel(out float db);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid ctx);
  [PreserveSig] int GetChannelVolumeLevel(uint ch, out float db);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint ch, out float l);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr ctl);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr vol);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s);
}
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string n, ref Guid ctx);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string p, ref Guid ctx);
  [PreserveSig] int GetGroupingParam(out Guid g);
  [PreserveSig] int SetGroupingParam(ref Guid g, ref Guid ctx);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
  [PreserveSig] int GetPeakValue(out float peak);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCo { }

public class MixSession {
  public int Pid; public string Name; public string Title; public string Path; public float Volume; public bool Muted; public float Peak; public bool IsSystem; public int State;
}

public static class PccMix {
  static IMMDevice Dev(int flow) {
    IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCo());
    IMMDevice d;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(flow, 1, out d));
    return d;
  }
  static object Act(IMMDevice d, Guid g) {
    object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref g, 23, IntPtr.Zero, out o));
    return o;
  }
  static IAudioEndpointVolume Endpoint(int flow) { return (IAudioEndpointVolume)Act(Dev(flow), typeof(IAudioEndpointVolume).GUID); }

  static List<IAudioSessionControl2> Raw() {
    List<IAudioSessionControl2> list = new List<IAudioSessionControl2>();
    IAudioSessionManager2 mgr = (IAudioSessionManager2)Act(Dev(0), typeof(IAudioSessionManager2).GUID);
    IAudioSessionEnumerator en;
    Marshal.ThrowExceptionForHR(mgr.GetSessionEnumerator(out en));
    int n;
    en.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IAudioSessionControl2 s;
      if (en.GetSession(i, out s) == 0 && s != null) list.Add(s);
    }
    return list;
  }

  public static List<MixSession> Sessions() {
    List<MixSession> res = new List<MixSession>();
    foreach (IAudioSessionControl2 s in Raw()) {
      try {
        int state; s.GetState(out state);
        if (state == 2) continue; // сеанс завершён
        MixSession m = new MixSession();
        m.State = state;
        uint pid; s.GetProcessId(out pid);
        m.Pid = (int)pid;
        m.IsSystem = s.IsSystemSoundsSession() == 0;
        string dn; s.GetDisplayName(out dn);
        m.Title = dn ?? "";
        if (!m.IsSystem && pid != 0) {
          try {
            Process p = Process.GetProcessById((int)pid);
            m.Name = p.ProcessName;
            try { m.Path = p.MainModule.FileName; } catch { m.Path = ""; }
            try { if (!String.IsNullOrEmpty(m.Path)) { string d = FileVersionInfo.GetVersionInfo(m.Path).FileDescription; if (!String.IsNullOrEmpty(d)) m.Title = d; } } catch { }
          } catch { continue; }
        } else { m.Name = "system"; m.Path = ""; }
        ISimpleAudioVolume v = (ISimpleAudioVolume)s;
        float lv; v.GetMasterVolume(out lv); m.Volume = lv;
        bool mu; v.GetMute(out mu); m.Muted = mu;
        try { float pk; ((IAudioMeterInformation)s).GetPeakValue(out pk); m.Peak = pk; } catch { }
        res.Add(m);
      } catch { }
    }
    return res;
  }

  /** Громкость/звук всех сеансов программы (по имени процесса, «system» — системные звуки). */
  public static int SetByName(string name, float level, int mute) {
    int count = 0;
    Guid empty = Guid.Empty;
    foreach (IAudioSessionControl2 s in Raw()) {
      try {
        uint pid; s.GetProcessId(out pid);
        bool sys = s.IsSystemSoundsSession() == 0;
        string n = sys ? "system" : "";
        if (!sys) { try { n = Process.GetProcessById((int)pid).ProcessName; } catch { continue; } }
        if (!String.Equals(n, name, StringComparison.OrdinalIgnoreCase)) continue;
        ISimpleAudioVolume v = (ISimpleAudioVolume)s;
        if (level >= 0) v.SetMasterVolume(Math.Max(0f, Math.Min(1f, level)), ref empty);
        if (mute >= 0) v.SetMute(mute == 1, ref empty);
        count++;
      } catch { }
    }
    return count;
  }

  public static float MasterVolume() { float v; Endpoint(0).GetMasterVolumeLevelScalar(out v); return v; }
  public static bool MasterMute() { bool m; Endpoint(0).GetMute(out m); return m; }
  public static void SetMaster(float level, int mute) {
    Guid empty = Guid.Empty;
    IAudioEndpointVolume e = Endpoint(0);
    if (level >= 0) e.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, level)), ref empty);
    if (mute >= 0) e.SetMute(mute == 1, ref empty);
  }
  /** Микрофон по умолчанию: выключить/включить. Возвращает прежнее состояние (true — был выключен). */
  public static bool SetMicMute(bool mute) {
    Guid empty = Guid.Empty;
    IAudioEndpointVolume e = Endpoint(1);
    bool was; e.GetMute(out was);
    e.SetMute(mute, ref empty);
    return was;
  }

  public static string IconPng(string path) {
    try {
      using (System.Drawing.Icon ic = System.Drawing.Icon.ExtractAssociatedIcon(path))
      using (System.Drawing.Bitmap bmp = ic.ToBitmap())
      using (System.IO.MemoryStream ms = new System.IO.MemoryStream()) {
        bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
        return Convert.ToBase64String(ms.ToArray());
      }
    } catch { return ""; }
  }
}
}`;

const PS = `
$Mgr = $null
$AsTask = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
} catch { $AsTask = $null }
try { $null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] } catch {}
try { $null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime] } catch {}
function Await($op, [Type]$t) {
  $task = $AsTask.MakeGenericMethod($t).Invoke($null, @($op))
  if (-not $task.Wait(6000)) { throw 'Плеер не ответил' }
  $task.Result
}
function Manager {
  if (-not $script:Mgr) { $script:Mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]) }
  $script:Mgr
}
function Props($s) { try { Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]) } catch { $null } }
function SessInfo($s) {
  $p = Props $s
  $pi = $s.GetPlaybackInfo(); $tl = $s.GetTimelineProperties(); $c = $pi.Controls
  [ordered]@{
    app = [string]$s.SourceAppUserModelId
    title = [string]$p.Title; artist = [string]$p.Artist; album = [string]$p.AlbumTitle; albumArtist = [string]$p.AlbumArtist; subtitle = [string]$p.Subtitle
    track = $p.TrackNumber; tracks = $p.AlbumTrackCount; genres = @($p.Genres | ForEach-Object { [string]$_ }); type = [string]$p.PlaybackType
    status = [string]$pi.PlaybackStatus; shuffle = $pi.IsShuffleActive; repeat = [string]$pi.AutoRepeatMode
    position = $tl.Position.TotalSeconds; duration = ($tl.EndTime - $tl.StartTime).TotalSeconds; updated = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
    canPlay = $c.IsPlayEnabled; canPause = $c.IsPauseEnabled; canNext = $c.IsNextEnabled; canPrev = $c.IsPreviousEnabled; canSeek = $c.IsPlaybackPositionEnabled
    canShuffle = $c.IsShuffleEnabled; canRepeat = $c.IsRepeatEnabled; hasThumb = [bool]($p -and $p.Thumbnail)
  }
}
function FindSession($app) {
  foreach ($s in (Manager).GetSessions()) { if ([string]$s.SourceAppUserModelId -eq $app) { return $s } }
  $cur = (Manager).GetCurrentSession()
  if (-not $app -and $cur) { return $cur }
  throw 'Плеер не найден — возможно, он уже закрыт'
}
function State {
  $list = @(); $cur = ''; $err = ''
  if ($AsTask) {
    try {
      $m = Manager
      $c = $m.GetCurrentSession(); if ($c) { $cur = [string]$c.SourceAppUserModelId }
      foreach ($s in $m.GetSessions()) { try { $list += ,(SessInfo $s) } catch {} }
    } catch { $err = $_.Exception.Message; $script:Mgr = $null }
  } else { $err = 'WinRT недоступен' }
  $wins = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [ordered]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle; path = [string]$_.Path; desc = [string]$_.Description } })
  [ordered]@{ current = $cur; sessions = $list; windows = $wins; now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); error = $err }
}
function Thumb($app) {
  $s = FindSession $app
  $p = Props $s
  if (-not $p -or -not $p.Thumbnail) { return $null }
  $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $size = [uint32]$st.Size
  if ($size -eq 0) { throw 'плеер передал пустую обложку' }
  $r = [Windows.Storage.Streams.DataReader]::new($st.GetInputStreamAt(0))
  $null = Await ($r.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $r.ReadBytes($bytes)
  $r.Dispose(); $st.Dispose()
  [ordered]@{ type = [string]$st.ContentType; data = [Convert]::ToBase64String($bytes) }
}
function Control($app, $action, $value) {
  $s = FindSession $app
  $B = [bool]
  switch ($action) {
    'play' { Await ($s.TryPlayAsync()) $B }
    'pause' { Await ($s.TryPauseAsync()) $B }
    'toggle' { Await ($s.TryTogglePlayPauseAsync()) $B }
    'next' { Await ($s.TrySkipNextAsync()) $B }
    'prev' { Await ($s.TrySkipPreviousAsync()) $B }
    'stop' { Await ($s.TryStopAsync()) $B }
    'seek' { Await ($s.TryChangePlaybackPositionAsync([long]([double]$value * 10000000))) $B }
    'shuffle' { Await ($s.TryChangeShuffleActiveAsync([bool]$value)) $B }
    'repeat' { Await ($s.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode][int]$value)) $B }
    default { throw 'Неизвестное действие' }
  }
}
function Mixer {
  try { $mv = [PccMixNs.PccMix]::MasterVolume(); $mm = [PccMixNs.PccMix]::MasterMute() } catch { return [ordered]@{ master = $null; masterMuted = $false; sessions = @(); error = 'Нет устройства вывода звука' } }
  $s = @([PccMixNs.PccMix]::Sessions() | ForEach-Object { [ordered]@{ pid = $_.Pid; name = $_.Name; title = $_.Title; path = $_.Path; volume = $_.Volume; muted = $_.Muted; peak = $_.Peak; system = $_.IsSystem; state = $_.State } })
  [ordered]@{ master = $mv; masterMuted = $mm; sessions = $s }
}
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $id = 0
  try {
    $q = ConvertFrom-Json $line
    $id = $q.id
    switch ($q.op) {
      'state' { Reply $id $true (State) }
      'thumb' { Reply $id $true (Thumb $q.app) }
      'control' { Reply $id $true (Control $q.app $q.action $q.value) }
      'mixer' { Reply $id $true (Mixer) }
      'setapp' { Reply $id $true ([PccMixNs.PccMix]::SetByName([string]$q.name, [float]$q.level, [int]$q.mute)) }
      'master' { [PccMixNs.PccMix]::SetMaster([float]$q.level, [int]$q.mute); Reply $id $true $true }
      'mic' { Reply $id $true ([PccMixNs.PccMix]::SetMicMute([bool]$q.mute)) }
      'icon' { Reply $id $true ([PccMixNs.PccMix]::IconPng([string]$q.path)) }
      default { Reply $id $false 'unknown op' }
    }
  } catch { Reply $id $false $_.Exception.Message }
}`;

// Как называются плееры в Windows (идентификатор приложения → понятное имя и процессы)
const KNOWN = [
  [/spotify/i, 'Spotify', ['spotify']],
  [/yandex\.?music|yandexmusic|Яндекс Музыка/i, 'Яндекс Музыка', ['yandexmusic', 'Яндекс Музыка', 'Yandex Music']],
  [/^308046B0AF4A39CB$|firefox/i, 'Firefox', ['firefox']],
  [/msedge|microsoftedge/i, 'Microsoft Edge', ['msedge']],
  [/chrome/i, 'Google Chrome', ['chrome']],
  [/yandex/i, 'Яндекс Браузер', ['browser']],
  [/opera/i, 'Opera', ['opera']],
  [/brave/i, 'Brave', ['brave']],
  [/vivaldi/i, 'Vivaldi', ['vivaldi']],
  [/zunemusic|zunevideo|media\.?player/i, 'Медиаплеер Windows', ['Microsoft.Media.Player', 'Music.UI', 'Video.UI']],
  [/aimp/i, 'AIMP', ['aimp']],
  [/foobar/i, 'foobar2000', ['foobar2000']],
  [/vlc/i, 'VLC', ['vlc']],
  [/potplayer/i, 'PotPlayer', ['PotPlayerMini64', 'PotPlayerMini']],
  [/telegram/i, 'Telegram', ['telegram']],
  [/discord/i, 'Discord', ['discord']],
  [/itunes|applemusic/i, 'Apple Music', ['itunes', 'AppleMusic']],
  [/winamp/i, 'Winamp', ['winamp']],
  [/tidal/i, 'TIDAL', ['tidal']],
  [/deezer/i, 'Deezer', ['deezer']],
  [/soundcloud/i, 'SoundCloud', ['soundcloud']],
  [/vk/i, 'VK Музыка', ['vk', 'VK Music']],
];

/** Понятное имя плеера и имена процессов по идентификатору приложения Windows (AUMID). */
function appInfo(aumid) {
  const id = String(aumid || '');
  for (const [re, name, procs] of KNOWN) if (re.test(id)) return { name, procs, known: true };
  // Обычная программа: «Something.exe»; приложение из Store: «Издатель.Имя_хеш!App»
  let base = id.split('!')[0].replace(/\.exe$/i, '');
  if (base.includes('_')) base = base.split('_')[0];
  base = base.split('\\').pop();
  const short = base.includes('.') && !/\.exe$/i.test(id) ? base.split('.').pop() : base;
  return { name: short || 'Плеер', procs: [short, base].filter(Boolean), known: false };
}

const STATUS_RU = { Playing: 'играет', Paused: 'на паузе', Stopped: 'остановлено', Changing: 'переключается', Opened: 'открыто', Closed: 'закрыто' };

/** Строка из помощника → понятное описание сеанса воспроизведения (с окном программы). */
function describe(s, windows = [], now = Date.now()) {
  const info = appInfo(s.app);
  const procs = info.procs.map((p) => p.toLowerCase());
  const wins = windows.filter((w) => procs.includes(String(w.name).toLowerCase()));
  // Окно, в заголовке которого есть название трека (вкладка YouTube и т. п.), иначе — первое окно программы
  const norm = (t) => String(t || '').toLowerCase();
  const win = wins.find((w) => s.title && norm(w.title).includes(norm(s.title).slice(0, 24))) || wins[0] || null;
  const playing = s.status === 'Playing';
  let position = Number(s.position) || 0;
  const duration = Number(s.duration) || 0;
  if (playing && s.updated > 0 && duration > 0) position = Math.min(duration, position + Math.max(0, (now - s.updated) / 1000));
  const key = crypto.createHash('sha1').update([s.app, s.title, s.artist, s.album].join('\u0001')).digest('hex').slice(0, 16);
  return {
    app: s.app, appName: info.known ? info.name : (win && win.desc) || info.name,
    process: win ? win.name : (info.procs[0] || ''), pid: win ? win.pid : null, window: win ? win.title : '', exe: win ? win.path : '',
    title: s.title || '', artist: s.artist || s.albumArtist || '', album: s.album || '', albumArtist: s.albumArtist || '', subtitle: s.subtitle || '',
    track: s.track || null, tracks: s.tracks || null, genres: (s.genres || []).filter(Boolean), type: s.type || '',
    status: s.status || '', statusText: STATUS_RU[s.status] || s.status || '', playing,
    position: Math.round(position), duration: Math.round(duration),
    shuffle: s.shuffle, repeat: s.repeat || '',
    can: { play: !!s.canPlay, pause: !!s.canPause, next: !!s.canNext, prev: !!s.canPrev, seek: !!s.canSeek && duration > 0, shuffle: !!s.canShuffle, repeat: !!s.canRepeat },
    cover: s.title ? key : null, hasThumb: !!s.hasThumb,
  };
}

class MediaInfo {
  constructor(ctx) {
    this.ctx = ctx;
    this.agent = IS_WIN ? new PsAgent({ name: 'PccMedia', cs: CS, ps: PS, dataDir: ctx.dataDir, idleMs: 15 * 60 * 1000 }) : null;
    this.covers = new Map(); // ключ → { buf, type }
    this.icons = new Map(); // путь → data:URL
    this.coverMiss = new Map(); // ключ → когда не нашли
    this.coverLoading = new Map(); // ключ → идущий поиск
    this.last = null;
  }

  get available() { return !!this.agent; }

  /** Все плееры: что играет, где, позиция. Сначала — то, что играет сейчас. */
  async state() {
    if (!this.agent) return { available: false, sessions: [] };
    const r = await this.agent.call('state', {}, 20000);
    const sessions = (r.sessions || []).map((s) => describe(s, r.windows || [], r.now || Date.now()));
    sessions.sort((a, b) => (b.playing - a.playing) || ((b.app === r.current) - (a.app === r.current)));
    for (const s of sessions) s.icon = s.exe ? await this.icon(s.exe) : null;
    // Обложки заранее, чтобы телефон и бот показывали их сразу
    // Одна и та же обложка не ищется дважды, даже если запросы пришли одновременно
    await Promise.all(sessions.filter((s) => s.cover && !this.covers.has(s.cover)).map((s) => {
      if (!this.coverLoading.has(s.cover)) this.coverLoading.set(s.cover, this.loadCover(s).catch(() => null).finally(() => this.coverLoading.delete(s.cover)));
      return this.coverLoading.get(s.cover);
    }));
    for (const s of sessions) if (s.cover && !this.covers.has(s.cover)) s.cover = null;
    this.last = { sessions, current: r.current, ts: Date.now() };
    return { available: true, sessions, current: r.current, error: r.error || '' };
  }

  /**
   * Обложка: сначала та, что передал плеер; если её нет (браузеры часто не передают) —
   * из открытых каталогов музыки по исполнителю и названию. Неудачи запоминаем на 10 минут.
   */
  async loadCover(s) {
    const miss = this.coverMiss.get(s.cover);
    if (miss && Date.now() - miss < 600000) return null;
    let v = null;
    if (s.hasThumb) {
      for (let i = 0; i < 2 && !v; i++) {
        try {
          const t = await this.agent.call('thumb', { app: s.app }, 15000);
          if (t && t.data) v = { buf: Buffer.from(t.data, 'base64'), type: t.type || 'image/jpeg', source: 'player' };
        } catch (e) {
          if (!this.thumbErrLogged) { this.thumbErrLogged = true; try { this.ctx.db.addEvent('info', 'media', `Обложка от плеера не прочиталась: ${e.message}`); } catch (er) { /* ignore */ } }
          await new Promise((r) => setTimeout(r, 400));
        }
      }
    }
    if (!v && (this.ctx.config.media || {}).onlineCovers !== false) {
      v = await findCover(s.artist, s.title).catch(() => null);
    }
    if (!v) { this.coverMiss.set(s.cover, Date.now()); return null; }
    this.covers.set(s.cover, v);
    while (this.covers.size > 30) this.covers.delete(this.covers.keys().next().value);
    return v;
  }

  cover(key) { return this.covers.get(String(key || '')) || null; }

  async icon(path) {
    if (!path || !this.agent) return null;
    if (this.icons.has(path)) return this.icons.get(path);
    let url = null;
    try { const b64 = await this.agent.call('icon', { path }, 10000); url = b64 ? `data:image/png;base64,${b64}` : null; } catch (e) { /* без значка */ }
    this.icons.set(path, url);
    return url;
  }

  async control(app, action, value = null) {
    if (!this.agent) throw new Error('Управление плеерами доступно в Windows 10 и 11');
    if (!['play', 'pause', 'toggle', 'next', 'prev', 'stop', 'seek', 'shuffle', 'repeat'].includes(action)) throw new Error('Неизвестное действие');
    const ok = await this.agent.call('control', { app: String(app || ''), action, value }, 15000);
    if (ok === false) throw new Error('Плеер не поддерживает это действие');
    return { ok: true };
  }

  // ---------------- микшер ----------------
  /** Программы, которые сейчас выводят звук, с громкостью каждой (как «Микшер громкости» Windows). */
  async mixer() {
    if (!this.agent) return { available: false, apps: [] };
    const r = await this.agent.call('mixer', {}, 15000);
    if (r.master == null) return { available: true, noDevice: true, error: r.error || 'Нет устройства вывода звука', master: 0, masterMuted: false, apps: [] };
    const groups = new Map();
    for (const s of r.sessions || []) {
      const key = String(s.name || '').toLowerCase();
      let g = groups.get(key);
      if (!g) {
        g = { name: s.name, title: s.system ? 'Системные звуки' : (s.title || s.name), path: s.path, system: !!s.system, volume: s.volume, muted: s.muted, peak: 0, active: false, pids: [] };
        groups.set(key, g);
      }
      g.pids.push(s.pid);
      g.peak = Math.max(g.peak, s.peak || 0);
      g.active = g.active || s.state === 1;
      if (s.volume > g.volume) g.volume = s.volume;
      g.muted = g.muted && s.muted;
    }
    const apps = [...groups.values()];
    for (const a of apps) {
      a.volume = Math.round((a.volume || 0) * 100);
      a.peak = Math.round(a.peak * 100);
      a.icon = a.path ? await this.icon(a.path) : null;
    }
    apps.sort((a, b) => (a.system - b.system) || (b.active - a.active) || (b.peak - a.peak) || a.title.localeCompare(b.title));
    return { available: true, master: Math.round((r.master || 0) * 100), masterMuted: !!r.masterMuted, apps };
  }

  async setApp(name, { level = null, mute = null } = {}) {
    if (!this.agent) throw new Error('Микшер доступен в Windows');
    const lv = level == null ? -1 : Math.max(0, Math.min(100, Number(level))) / 100;
    const n = await this.agent.call('setapp', { name: String(name), level: lv, mute: mute == null ? -1 : mute ? 1 : 0 });
    if (!n) throw new Error('Программа больше не выводит звук');
    return { ok: true };
  }

  async setMaster({ level = null, mute = null } = {}) {
    if (!this.agent) throw new Error('Микшер доступен в Windows');
    await this.agent.call('master', { level: level == null ? -1 : Math.max(0, Math.min(100, Number(level))) / 100, mute: mute == null ? -1 : mute ? 1 : 0 });
    return { ok: true };
  }

  /** Микрофон по умолчанию; возвращает, был ли он выключен до этого. */
  async setMicMute(mute) {
    if (!this.agent) throw new Error('Только в Windows');
    return !!(await this.agent.call('mic', { mute: !!mute }));
  }

  stop() { if (this.agent) this.agent.kill(); }
}

module.exports = { MediaInfo, appInfo, describe };
