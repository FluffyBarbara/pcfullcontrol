'use strict';
// Автозагрузка Windows: программы, которые запускаются при входе в систему.
// Включение/выключение — как в Диспетчере задач (раздел StartupApproved): запись не удаляется,
// её всегда можно включить обратно. Задачи Планировщика — через Enable/Disable-ScheduledTask.
const crypto = require('crypto');
const { IS_WIN, powershell, psQuote } = require('./exec');

const LIST_PS = `
$ErrorActionPreference = 'SilentlyContinue'
function Approved($path, $name) {
  $v = (Get-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue).$name
  if ($v -is [byte[]] -and $v.Length -gt 0) { return (($v[0] -band 1) -eq 0) }
  return $true
}
function ExeOf($cmd) {
  $c = [Environment]::ExpandEnvironmentVariables([string]$cmd).Trim()
  if ($c.StartsWith('"')) { return $c.Substring(1, $c.IndexOf('"', 1) - 1) }
  $m = [regex]::Match($c, '^(.+?\\.(exe|bat|cmd|lnk|vbs|ps1))', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return ($c -split ' ')[0]
}
function Company($exe) {
  try { if ($exe -and (Test-Path -LiteralPath $exe)) { return (Get-Item -LiteralPath $exe).VersionInfo.CompanyName } } catch {}
  return ''
}
$sa = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved'
$out = @()
$runs = @(
  @{ hive='HKCU'; key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; appr="HKCU:\\$sa\\Run"; src='Реестр (ваша учётная запись)' },
  @{ hive='HKLM'; key='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'; appr="HKLM:\\$sa\\Run"; src='Реестр (все пользователи)' },
  @{ hive='HKLM'; key='HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; appr="HKLM:\\$sa\\Run32"; src='Реестр (32-битные, все пользователи)' }
)
foreach ($r in $runs) {
  $p = Get-ItemProperty -Path $r.key
  if (-not $p) { continue }
  foreach ($prop in $p.PSObject.Properties) {
    if ($prop.Name -like 'PS*') { continue }
    $exe = ExeOf $prop.Value
    $out += [pscustomobject]@{ kind='reg'; name=$prop.Name; command=[string]$prop.Value; source=$r.src; loc=$r.key; appr=$r.appr; enabled=(Approved $r.appr $prop.Name); publisher=(Company $exe); exe=$exe }
  }
}
$folders = @(
  @{ dir=[Environment]::GetFolderPath('Startup'); appr="HKCU:\\$sa\\StartupFolder"; src='Папка «Автозагрузка» (ваша)' },
  @{ dir=[Environment]::GetFolderPath('CommonStartup'); appr="HKLM:\\$sa\\StartupFolder"; src='Папка «Автозагрузка» (общая)' }
)
$sh = New-Object -ComObject WScript.Shell
foreach ($f in $folders) {
  if (-not $f.dir -or -not (Test-Path $f.dir)) { continue }
  Get-ChildItem -LiteralPath $f.dir -File | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object {
    $target = $_.FullName
    if ($_.Extension -eq '.lnk') { try { $target = $sh.CreateShortcut($_.FullName).TargetPath } catch {} }
    $out += [pscustomobject]@{ kind='folder'; name=$_.Name; command=$target; source=$f.src; loc=$f.dir; appr=$f.appr; enabled=(Approved $f.appr $_.Name); publisher=(Company $target); exe=$target }
  }
}
Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' -and ($_.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' }) } | ForEach-Object {
  $a = $_.Actions | Select-Object -First 1
  $exe = [Environment]::ExpandEnvironmentVariables([string]$a.Execute).Trim('"')
  $out += [pscustomobject]@{ kind='task'; name=$_.TaskName; command=(([string]$a.Execute) + ' ' + [string]$a.Arguments).Trim(); source='Планировщик заданий'; loc=$_.TaskPath; appr=''; enabled=($_.State -ne 'Disabled'); publisher=(Company $exe); exe=$exe }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3`;

class StartupManager {
  constructor() { this.items = new Map(); }

  get available() { return IS_WIN; }

  async list() {
    if (!IS_WIN) return [];
    const r = await powershell(LIST_PS, 90000);
    let rows;
    try { rows = JSON.parse(r.out || '[]'); } catch (e) { throw new Error('Не удалось прочитать список автозагрузки'); }
    if (!Array.isArray(rows)) rows = [rows];
    this.items.clear();
    const out = [];
    for (const x of rows.filter(Boolean)) {
      const id = crypto.createHash('sha1').update(`${x.kind}|${x.loc}|${x.name}`).digest('hex').slice(0, 16);
      const self = x.kind === 'task' && x.name === 'PCFullControl';
      this.items.set(id, { ...x, id, self });
      out.push({ id, kind: x.kind, name: x.name.replace(/\.lnk$/i, ''), command: x.command, source: x.source, enabled: !!x.enabled, publisher: x.publisher || '', self });
    }
    out.sort((a, b) => (b.enabled - a.enabled) || a.name.localeCompare(b.name, 'ru'));
    return out;
  }

  /** Включает или выключает запуск программы при входе. Запись остаётся — действие обратимо. */
  async setEnabled(id, enabled) {
    const x = this.items.get(String(id || ''));
    if (!x) throw new Error('Элемент не найден — обновите список');
    if (x.self) throw new Error('Автозапуск PC Full Control меняется в настройках программы');
    let script;
    if (x.kind === 'task') {
      script = `${enabled ? 'Enable' : 'Disable'}-ScheduledTask -TaskPath ${psQuote(x.loc)} -TaskName ${psQuote(x.name)} -ErrorAction Stop | Out-Null; 'ok'`;
    } else {
      // Как Диспетчер задач: 02 — включено, 03 + время — выключено
      const bytes = enabled ? '[byte[]]@(2,0,0,0,0,0,0,0,0,0,0,0)'
        : '[byte[]](@([byte]3,[byte]0,[byte]0,[byte]0) + [BitConverter]::GetBytes([DateTime]::Now.ToFileTimeUtc()))';
      script = `$p = ${psQuote(x.appr)}; if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
[byte[]]$v = ${bytes}; Set-ItemProperty -Path $p -Name ${psQuote(x.name)} -Value $v -Type Binary -ErrorAction Stop; 'ok'`;
    }
    const r = await powershell(script, 30000);
    if (!/ok\s*$/.test(r.out)) throw new Error(r.out || 'Не удалось изменить автозагрузку');
    x.enabled = enabled;
    return { ok: true, enabled };
  }
}

module.exports = { StartupManager };
