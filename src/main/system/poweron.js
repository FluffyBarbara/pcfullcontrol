'use strict';
// Включение ПК с телефона (Wake-on-LAN) и автовход без пароля, если ПК включили с телефона.
const os = require('os');
const { spawn } = require('child_process');
const { IS_WIN, powershell, PS_EXE } = require('./exec');

/** Основной сетевой адаптер: MAC и широковещательный адрес домашней сети. */
function primaryInterface() {
  const all = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tailscale|zerotier/i.test(name)) continue;
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && a.mac && a.mac !== '00:00:00:00:00:00') {
        const rank = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
        all.push({ name, ip: a.address, mac: a.mac.toUpperCase(), netmask: a.netmask, rank, wifi: /wi-?fi|wlan|wireless|беспровод/i.test(name) });
      }
    }
  }
  all.sort((a, b) => a.rank - b.rank || Number(a.wifi) - Number(b.wifi));
  const p = all[0];
  if (!p) return null;
  const ip = p.ip.split('.').map(Number);
  const mask = p.netmask.split('.').map(Number);
  p.broadcast = ip.map((o, i) => (o & mask[i]) | (~mask[i] & 255)).join('.');
  return p;
}

/** Настраивает Windows для включения по сети: Wake on Magic Packet на адаптерах и разрешение будить ПК. */
async function setupWindows() {
  if (!IS_WIN) return 'Настройка доступна только в Windows.';
  const r = await powershell(`
$out = @()
$all = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' }
if (-not $all) { 'Не найдено подключённых сетевых адаптеров.'; exit 0 }
$wired = $all | Where-Object { $_.MediaType -eq '802.3' -and $_.PhysicalMediaType -notmatch '802.11' }
foreach ($a in $all) {
  $n = $a.Name
  try { Set-NetAdapterPowerManagement -Name $n -WakeOnMagicPacket Enabled -ErrorAction Stop; $out += "✔ $n — пробуждение «волшебным пакетом» включено" }
  catch { $out += "• $n — Wake on Magic Packet: не поддерживается или уже настроено" }
  foreach ($kw in '*WakeOnMagicPacket', 'S5WakeOnLan', 'WakeOnLink') {
    Set-NetAdapterAdvancedProperty -Name $n -RegistryKeyword $kw -RegistryValue 1 -ErrorAction SilentlyContinue
  }
  powercfg /deviceenablewake "$($a.InterfaceDescription)" 2>&1 | Out-Null
}
$armed = (powercfg /devicequery wake_armed) -join ', '
$out += "Могут будить ПК: $armed"
if (-not $wired) { $out += "⚠ Компьютер подключён по Wi-Fi. Включение по сети почти всегда работает только по кабелю (Ethernet)." }
$out += "Дальше: включите в BIOS/UEFI пункт «Wake on LAN» / «Power On By PCI-E» и отключите «ErP» / «Deep Sleep»."
$out`, 120000);
  return r.out || 'Готово';
}

// ---------------- автовход ----------------

const LSA_CS = `
using System;
using System.Runtime.InteropServices;
public static class PccLsa {
  [StructLayout(LayoutKind.Sequential)] struct LSA_UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct LSA_OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr systemName, ref LSA_OBJECT_ATTRIBUTES attrs, uint access, out IntPtr handle);
  [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr handle, ref LSA_UNICODE_STRING key, IntPtr data);
  [DllImport("advapi32.dll")] static extern uint LsaNtStatusToWinError(uint status);
  [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LogonUser(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static LSA_UNICODE_STRING Str(string s) { var u = new LSA_UNICODE_STRING(); u.Buffer = Marshal.StringToHGlobalUni(s); u.Length = (ushort)(s.Length * 2); u.MaximumLength = (ushort)(s.Length * 2 + 2); return u; }
  public static uint Store(string key, string value) {
    var oa = new LSA_OBJECT_ATTRIBUTES(); oa.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));
    IntPtr h; uint st = LsaOpenPolicy(IntPtr.Zero, ref oa, 0x000F0FFF, out h);
    if (st != 0) return LsaNtStatusToWinError(st);
    var k = Str(key); IntPtr data = IntPtr.Zero; var v = new LSA_UNICODE_STRING();
    try {
      if (value != null) { v = Str(value); data = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(LSA_UNICODE_STRING))); Marshal.StructureToPtr(v, data, false); }
      st = LsaStorePrivateData(h, ref k, data);
    } finally {
      LsaClose(h);
      Marshal.FreeHGlobal(k.Buffer);
      // Пароль в памяти затираем нулями до освобождения
      if (v.Buffer != IntPtr.Zero) { Marshal.Copy(new byte[v.MaximumLength], 0, v.Buffer, v.MaximumLength); Marshal.FreeHGlobal(v.Buffer); }
      if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
    }
    return LsaNtStatusToWinError(st);
  }
  public static bool Check(string user, string domain, string password) {
    IntPtr t; bool ok = LogonUser(user, domain, password, 2, 0, out t);
    if (ok) CloseHandle(t);
    return ok;
  }
}`;

const WINLOGON = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
const PASSWORDLESS = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\PasswordLess\\Device';

/** PowerShell, которому пароль передаётся через stdin (не попадает в командную строку). */
function powershellWithInput(script, input, timeout = 60000) {
  return new Promise((resolve) => {
    const full = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + script;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    const p = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill(), timeout);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: e.message }); });
    p.stdin.end(String(input) + '\n');
  });
}

async function autologonState() {
  if (!IS_WIN) return { supported: false, enabled: false };
  const r = await powershell(`$w = Get-ItemProperty '${WINLOGON}' -ErrorAction SilentlyContinue
"$($w.AutoAdminLogon)|$($w.DefaultUserName)|$env:USERNAME"`, 20000);
  const [auto, user, me] = r.out.trim().split('|');
  return { supported: true, enabled: auto === '1', user: user || '', currentUser: me || '' };
}

async function enableAutologon(password) {
  if (!IS_WIN) throw new Error('Только для Windows');
  if (!password) throw new Error('Введите пароль от учётной записи Windows');
  const r = await powershellWithInput(`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${LSA_CS}
'@
$pw = [Console]::In.ReadLine()
$user = $env:USERNAME
$domain = $env:USERDOMAIN
if (-not [PccLsa]::Check($user, $domain, $pw)) { 'ERR:Неверный пароль. Нужен пароль от учётной записи (не PIN-код).'; exit 1 }
$e = [PccLsa]::Store('DefaultPassword', $pw)
if ($e -ne 0) { "ERR:Не удалось сохранить пароль в защищённом хранилище Windows (код $e)"; exit 1 }
Set-ItemProperty '${WINLOGON}' -Name AutoAdminLogon -Value '1'
Set-ItemProperty '${WINLOGON}' -Name DefaultUserName -Value $user
Set-ItemProperty '${WINLOGON}' -Name DefaultDomainName -Value $domain
Remove-ItemProperty '${WINLOGON}' -Name DefaultPassword -ErrorAction SilentlyContinue
Remove-ItemProperty '${WINLOGON}' -Name AutoLogonCount -ErrorAction SilentlyContinue
# Для учётных записей Microsoft: разрешить вход по паролю, а не только Windows Hello
if (Test-Path '${PASSWORDLESS}') { Set-ItemProperty '${PASSWORDLESS}' -Name DevicePasswordLessBuildVersion -Value 0 -Type DWord }
# После сна не спрашивать пароль — программа сама заблокирует экран, если ПК разбудили не с телефона
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /SETACTIVE SCHEME_CURRENT
"OK:$user"`, password, 60000);
  const err = (r.out.match(/ERR:(.*)/) || [])[1];
  if (err) throw new Error(err.trim());
  if (!/OK:/.test(r.out)) throw new Error(r.out.split('\n').slice(-3).join(' ') || 'не удалось включить автовход');
  return 'Автовход включён';
}

async function disableAutologon() {
  if (!IS_WIN) return 'Только для Windows';
  await powershell(`Add-Type -TypeDefinition @'
${LSA_CS}
'@
[void][PccLsa]::Store('DefaultPassword', $null)
Set-ItemProperty '${WINLOGON}' -Name AutoAdminLogon -Value '0'
Remove-ItemProperty '${WINLOGON}' -Name DefaultPassword -ErrorAction SilentlyContinue
if (Test-Path '${PASSWORDLESS}') { Set-ItemProperty '${PASSWORDLESS}' -Name DevicePasswordLessBuildVersion -Value 2 -Type DWord }
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 1
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 1
powercfg /SETACTIVE SCHEME_CURRENT
'OK'`, 60000);
  return 'Автовход выключен, пароль удалён';
}

/**
 * Чем разбудили ПК: 'network' — сетевой картой (с телефона), 'other' — кнопкой/клавиатурой.
 * afterLogon: проверка сразу после входа в Windows — если вход был давно (просто перезапуск программы), вернёт 'skip'.
 */
async function wakeSource(afterLogon = false) {
  if (!IS_WIN) return 'unknown';
  const r = await powershell(`
${afterLogon ? "$ex = Get-Process explorer -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($ex -and ((Get-Date) - $ex.StartTime).TotalMinutes -gt 3) { 'skip'; exit 0 }" : ''}
$names = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object { $_.InterfaceDescription })
$t = (powercfg /lastwake | Out-String)
$t += (Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Power-Troubleshooter'; StartTime = (Get-Date).AddMinutes(-15) } -MaxEvents 3 -ErrorAction SilentlyContinue | ForEach-Object { $_.Message } | Out-String)
if ($names | Where-Object { $_ -and $t.Contains($_) }) { 'network' } else { 'other' }`, 30000);
  if (/skip/.test(r.out)) return 'skip';
  return /network/.test(r.out) ? 'network' : 'other';
}

module.exports = { primaryInterface, setupWindows, autologonState, enableAutologon, disableAutologon, wakeSource };
