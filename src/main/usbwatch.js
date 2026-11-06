'use strict';
// Подключение USB-устройств: флешки, внешние диски, телефоны, клавиатуры, мыши, камеры, модемы.
// Windows сообщает о каждом новом устройстве (WMI); одно физическое устройство появляется сразу
// несколькими записями — собираем их за 3 секунды в одно уведомление с понятным названием.
const { spawn } = require('child_process');
const { IS_WIN, powershell } = require('./system/exec');
const { E } = require('./telegram-api');

const AGENT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$q = "TargetInstance ISA 'Win32_PnPEntity'"
Register-CimIndicationEvent -Query "SELECT * FROM __InstanceCreationEvent WITHIN 2 WHERE $q" -SourceIdentifier pcfcAdd | Out-Null
Register-CimIndicationEvent -Query "SELECT * FROM __InstanceDeletionEvent WITHIN 2 WHERE $q" -SourceIdentifier pcfcDel | Out-Null
[Console]::Out.WriteLine('ready')
while ($true) {
  $e = Wait-Event -Timeout 600
  if (-not $e) { continue }
  try {
    $t = $e.SourceEventArgs.NewEvent.TargetInstance
    $o = [ordered]@{ kind = $(if ($e.SourceIdentifier -eq 'pcfcAdd') { 'add' } else { 'remove' }); name = [string]$t.Name; cls = [string]$t.PNPClass; id = [string]$t.DeviceID; mfr = [string]$t.Manufacturer }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
  } catch {}
  Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
}`;

const DISKS_PS = `$out = foreach ($d in @(Get-CimInstance Win32_DiskDrive | Where-Object { $_.InterfaceType -eq 'USB' -or $_.PNPDeviceID -like 'USBSTOR*' -or $_.MediaType -like 'Removable*' })) {
  $vols = @()
  foreach ($p in @(Get-CimAssociatedInstance -InputObject $d -ResultClassName Win32_DiskPartition -ErrorAction SilentlyContinue)) {
    foreach ($l in @(Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_LogicalDisk -ErrorAction SilentlyContinue)) {
      $vols += [ordered]@{ letter = [string]$l.DeviceID; label = [string]$l.VolumeName; size = [int64]$l.Size; free = [int64]$l.FreeSpace; fs = [string]$l.FileSystem }
    }
  }
  [ordered]@{ id = [string]$d.PNPDeviceID; model = [string]$d.Model; size = [int64]$d.Size; vols = $vols }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4`;

const RELEVANT = /^(USB\\|USBSTOR\\|SCSI\\|WPDBUSENUM\\|HID\\|SWD\\WPDBUSENUM)/i;
const GENERIC = /^(USB (Composite|Mass Storage|Input|Attached SCSI)|Составное USB|Запоминающее устройство для USB|Устройство ввода USB|HID-(compliant|совместим)|USB Root Hub|Generic USB Hub|Корневой USB|Универсальный USB|Generic volume|Том|USB-устройство|Неизвестное USB|Unknown USB|Disk drive|Дисковод|USB Printing Support|Поддержка USB принтера)/i;
const KIND = [
  [/DiskDrive|Volume|WPD/i, 'disk', '💾', 'накопитель'],
  [/Keyboard/i, 'keyboard', '⌨️', 'клавиатура'],
  [/Mouse/i, 'mouse', '🖱', 'мышь'],
  [/Camera|Image/i, 'camera', '📷', 'камера'],
  [/AudioEndpoint|MEDIA/i, 'audio', '🎧', 'звуковое устройство'],
  [/Net/i, 'net', '🌐', 'сетевое устройство (модем, Wi-Fi, сеть)'],
  [/Ports/i, 'port', '🔌', 'устройство на COM-порту'],
  [/Printer/i, 'printer', '🖨', 'принтер'],
  [/Bluetooth/i, 'bluetooth', '📶', 'Bluetooth-адаптер'],
];

/** Несколько записей WMI об одном подключении → { kind, icon, kindText, name, ids }. */
function summarize(items) {
  const rel = items.filter((x) => RELEVANT.test(x.id) && !/^HID\\\{0000/i.test(x.id) && !/STORAGE\\VOLUME/i.test(x.id));
  if (!rel.length) return null;
  let kind = null;
  for (const [re, k, icon, text] of KIND) {
    if (rel.some((x) => re.test(x.cls))) { kind = { kind: k, icon, kindText: text }; break; }
  }
  if (!kind) kind = { kind: 'usb', icon: '🔌', kindText: 'USB-устройство' };
  if (kind.kind === 'disk' && rel.some((x) => /WPD/i.test(x.cls)) && !rel.some((x) => /DiskDrive/i.test(x.cls))) kind = { kind: 'phone', icon: '📱', kindText: 'телефон или плеер' };
  const named = rel.map((x) => String(x.name || '').replace(/\s+USB Device$/i, '').trim()).filter((n) => n && !GENERIC.test(n));
  const pref = rel.filter((x) => /DiskDrive|WPD|Camera|Image|Keyboard|Mouse|AudioEndpoint|MEDIA|Net/i.test(x.cls)).map((x) => String(x.name || '').replace(/\s+USB Device$/i, '').trim()).filter((n) => n && !GENERIC.test(n));
  const mfr = rel.map((x) => x.mfr).find((m) => m && !/^\((Standard|Стандарт)|^Microsoft|^Generic|^Стандартн/i.test(m));
  const vid = (/VID_([0-9A-F]{4})/i.exec(rel.map((x) => x.id).join(' ')) || [])[1];
  const name = pref[0] || named[0] || (mfr ? `${mfr}` : '') || rel[0].name || 'USB-устройство';
  return { ...kind, name, vendor: mfr || '', vid: vid || '', ids: rel.map((x) => x.id) };
}

class UsbWatch {
  constructor(ctx) {
    this.ctx = ctx;
    this.proc = null;
    this.batch = { add: [], remove: [] };
    this.timer = null;
    this.startedAt = 0;
    this.disks = [];
    this.restarts = 0;
  }

  get enabled() { return (this.ctx.config.security || {}).usbWatch !== false; }

  async start() {
    if (!IS_WIN || this.proc) return;
    this.startedAt = Date.now();
    this.disks = await this.usbDisks().catch(() => []);
    const encoded = Buffer.from(AGENT, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try { this.onEvent(JSON.parse(line)); } catch (e) { /* ignore */ }
      }
    });
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.restarts++ < 20) setTimeout(() => this.start().catch(() => {}), 60000);
    });
    p.on('error', () => { this.proc = null; });
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    clearTimeout(this.timer);
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
  }

  onEvent(ev) {
    if (Date.now() - this.startedAt < 20000) return; // устройства, найденные при запуске Windows
    (this.batch[ev.kind] || this.batch.add).push(ev);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), 3000);
  }

  async usbDisks() {
    const r = await powershell(DISKS_PS, 60000);
    let list = [];
    try { list = JSON.parse(r.out || '[]'); } catch (e) { list = []; }
    return (Array.isArray(list) ? list : [list]).filter(Boolean);
  }

  async flush() {
    const { add, remove } = this.batch;
    this.batch = { add: [], remove: [] };
    const before = this.disks;
    const now = await this.usbDisks().catch(() => before);
    this.disks = now;
    const fmt = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} ТБ` : `${Math.round(b / 1e9)} ГБ`);
    if (add.length) {
      const s = summarize(add);
      if (s) {
        const newDisks = now.filter((d) => !before.some((b) => b.id === d.id));
        const lines = [];
        for (const d of newDisks) {
          if (s.kind !== 'disk') { s.kind = 'disk'; s.icon = '💾'; s.kindText = 'накопитель'; }
          s.name = d.model.replace(/\s+USB Device$/i, '') || s.name;
          for (const v of d.vols || []) lines.push(`${v.letter} ${v.label ? `«${v.label}» ` : ''}— ${fmt(v.size)}, свободно ${fmt(v.free)}${v.fs ? ` (${v.fs})` : ''}`);
          if (!(d.vols || []).length && d.size) lines.push(`объём ${fmt(d.size)}`);
        }
        const info = lines.join('; ');
        this.ctx.db.addUsbEvent('add', `${s.icon} ${s.name}`, [s.kindText, info].filter(Boolean).join(' · '));
        if (this.enabled) {
          this.ctx.notifier.notify(`🔌 <b>К компьютеру подключили ${E(s.kindText)}</b>\n${s.icon} ${E(s.name)}${s.vendor && !s.name.includes(s.vendor) ? ` (${E(s.vendor)})` : ''}${lines.length ? '\n' + lines.map((l) => '• ' + E(l)).join('\n') : ''}`,
            { category: 'security', level: 'warning' });
        }
        this.ctx.emit('usb', { kind: 'add', ...s, info });
      }
    }
    if (remove.length) {
      const gone = before.filter((b) => !now.some((d) => d.id === b.id));
      for (const d of gone) {
        const name = d.model.replace(/\s+USB Device$/i, '');
        this.ctx.db.addUsbEvent('remove', `💾 ${name}`, 'извлечён');
        if (this.enabled) this.ctx.notifier.notify(`⏏️ Накопитель извлечён: ${E(name)}`, { category: 'security', level: 'info' });
      }
      if (!gone.length) {
        const s = summarize(remove);
        if (s) this.ctx.db.addUsbEvent('remove', `${s.icon} ${s.name}`, `${s.kindText} отключено`);
      }
    }
  }
}

module.exports = { UsbWatch, summarize };
