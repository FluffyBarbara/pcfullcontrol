'use strict';
// Громкость и управление воспроизведением.
// Windows: Core Audio API через PowerShell + C# (без сторонних программ), медиаклавиши через SendKeys.
const { IS_WIN, IS_MAC, run, powershell } = require('./exec');

const AUDIO_CS = `
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class PccAudio {
  static IAudioEndpointVolume Vol() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var epvid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
    return epv;
  }
  public static float Volume {
    get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, System.Guid.Empty)); }
  }
  public static bool Mute {
    get { bool mute; Marshal.ThrowExceptionForHR(Vol().GetMute(out mute)); return mute; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, System.Guid.Empty)); }
  }
}`;

function audioPs(body) {
  return powershell(`Add-Type -TypeDefinition @'\n${AUDIO_CS}\n'@\n${body}`, 30000);
}

// Медиаклавиши Windows: 173 mute, 174 тише, 175 громче, 176 след., 177 пред., 179 пауза
function sendKey(code, times = 1) {
  return powershell(`$w = New-Object -ComObject WScript.Shell; 1..${times} | ForEach-Object { $w.SendKeys([char]${code}) }`, 20000);
}

async function getVolume() {
  try {
    if (IS_WIN) {
      const r = await audioPs('[Console]::Write([math]::Round([PccAudio]::Volume * 100)); [Console]::Write(" "); [Console]::Write([PccAudio]::Mute)');
      const [v, m] = r.out.trim().split(/\s+/);
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? null : { level: n, muted: /true/i.test(m || '') };
    }
    if (IS_MAC) {
      const r = await run('osascript', ['-e', 'output volume of (get volume settings)']);
      return r.code === 0 ? { level: parseInt(r.out, 10), muted: false } : null;
    }
    const r = await run('pactl', ['get-sink-volume', '@DEFAULT_SINK@']);
    const m = r.out.match(/(\d+)%/);
    return m ? { level: parseInt(m[1], 10), muted: false } : null;
  } catch (e) {
    return null;
  }
}

async function setVolume(arg) {
  const level = parseInt(String(arg ?? '').replace('%', '').trim(), 10);
  if (Number.isNaN(level) || level < 0 || level > 100) throw new Error('Укажите громкость от 0 до 100');
  if (IS_WIN) {
    const r = await audioPs(`[PccAudio]::Mute = $false; [PccAudio]::Volume = ${level / 100}`);
    if (r.code !== 0) {
      // Запасной способ: клавиши громкости (шаг 2%)
      await sendKey(174, 50);
      await sendKey(175, Math.round(level / 2));
    }
  } else if (IS_MAC) {
    await run('osascript', ['-e', `set volume output volume ${level}`]);
  } else {
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0']);
    await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${level}%`]);
  }
  return `Громкость: ${level}%`;
}

async function step(up) {
  if (IS_WIN) await sendKey(up ? 175 : 174, 5);
  else if (IS_MAC) {
    const v = (await getVolume())?.level ?? 50;
    await run('osascript', ['-e', `set volume output volume ${Math.max(0, Math.min(100, v + (up ? 10 : -10)))}`]);
  } else await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', (up ? '+' : '-') + '10%']);
  const v = await getVolume();
  return v ? `Громкость: ${v.level}%` : (up ? 'Громче 🔊' : 'Тише 🔉');
}

const volumeUp = () => step(true);
const volumeDown = () => step(false);

async function mute() {
  if (IS_WIN) {
    const r = await audioPs('[PccAudio]::Mute = -not [PccAudio]::Mute; [Console]::Write([PccAudio]::Mute)');
    if (r.code === 0) return /true/i.test(r.out) ? 'Звук выключен 🔇' : 'Звук включён 🔊';
    await sendKey(173);
  } else if (IS_MAC) {
    await run('osascript', ['-e', 'set volume output muted (not (output muted of (get volume settings)))']);
  } else {
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
  }
  return 'Звук: вкл/выкл 🔇';
}

async function mediaKey(winCode, playerctl, label) {
  if (IS_WIN) await sendKey(winCode);
  else if (!IS_MAC) await run('playerctl', [playerctl]);
  return label;
}

const playPause = () => mediaKey(179, 'play-pause', '⏯ Пауза/воспроизведение');
const nextTrack = () => mediaKey(176, 'next', '⏭ Следующий трек');
const prevTrack = () => mediaKey(177, 'previous', '⏮ Предыдущий трек');

module.exports = { getVolume, setVolume, volumeUp, volumeDown, mute, playPause, nextTrack, prevTrack };
