'use strict';
// Здоровье дисков: данные самодиагностики (SMART) через Windows Storage — состояние, температура,
// износ SSD, часы работы, ошибки чтения. Только чтение, ничего не меняет.
const { IS_WIN, powershell } = require('./exec');

const PS = `
$disks = Get-PhysicalDisk | Sort-Object DeviceId
$fail = @{}
try { Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop | ForEach-Object { $fail[$_.InstanceName] = $_.PredictFailure } } catch {}
$out = foreach ($d in $disks) {
  $r = $null
  try { $r = $d | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
  $vols = @()
  try { $vols = @(Get-Disk -Number $d.DeviceId -ErrorAction Stop | Get-Partition -ErrorAction SilentlyContinue | Where-Object DriveLetter | ForEach-Object { [string]$_.DriveLetter + ':' }) } catch {}
  $pf = $false
  foreach ($k in $fail.Keys) { if ($fail[$k] -and $k -match [regex]::Escape([string]$d.SerialNumber).Trim()) { $pf = $true } }
  [pscustomobject]@{
    id = [string]$d.DeviceId; model = [string]$d.FriendlyName; serial = ([string]$d.SerialNumber).Trim()
    media = [string]$d.MediaType; bus = [string]$d.BusType; size = [int64]$d.Size
    health = [string]$d.HealthStatus; status = (@($d.OperationalStatus) -join ', ')
    temp = if ($r) { $r.Temperature } else { $null }; tempMax = if ($r) { $r.TemperatureMax } else { $null }
    wear = if ($r) { $r.Wear } else { $null }; hours = if ($r) { $r.PowerOnHours } else { $null }
    readErrors = if ($r) { $r.ReadErrorsUncorrected } else { $null }; writeErrors = if ($r) { $r.WriteErrorsUncorrected } else { $null }
    startStop = if ($r) { $r.StartStopCycleCount } else { $null }
    predictFailure = $pf; volumes = ($vols -join ' ')
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3`;

/** Итоговая оценка диска: ok | warn | bad, с понятными причинами. */
function assess(d) {
  const reasons = [];
  let level = 'ok';
  const bump = (l, why) => { reasons.push(why); if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
  if (d.predictFailure) bump('bad', 'диск сам сообщает о скорой поломке (SMART)');
  if (/unhealthy/i.test(d.health)) bump('bad', 'Windows считает диск неисправным');
  else if (/warning/i.test(d.health)) bump('warn', 'Windows предупреждает о проблемах с диском');
  if (d.readErrors > 0 || d.writeErrors > 0) bump(d.readErrors > 10 ? 'bad' : 'warn', `неисправленные ошибки чтения/записи: ${(d.readErrors || 0) + (d.writeErrors || 0)}`);
  if (d.wear != null) {
    if (d.wear >= 90) bump('bad', `ресурс SSD почти исчерпан (износ ${d.wear}%)`);
    else if (d.wear >= 70) bump('warn', `SSD заметно изношен (износ ${d.wear}%)`);
  }
  if (d.temp != null) {
    const limit = /ssd|nvme/i.test(`${d.media} ${d.bus}`) ? 70 : 55;
    if (d.temp >= limit + 10) bump('bad', `перегрев: ${d.temp}°C`);
    else if (d.temp >= limit) bump('warn', `высокая температура: ${d.temp}°C`);
  }
  return { level, reasons };
}

function normalize(rows) {
  return rows.map((r) => {
    const d = {
      id: r.id, model: r.model || 'Диск', serial: r.serial || '', media: r.media === 'Unspecified' ? '' : r.media || '', bus: r.bus || '',
      size: Number(r.size) || 0, health: r.health || '', status: r.status || '', temp: num(r.temp), tempMax: num(r.tempMax),
      wear: num(r.wear), hours: num(r.hours), readErrors: num(r.readErrors), writeErrors: num(r.writeErrors),
      predictFailure: !!r.predictFailure, volumes: r.volumes || '',
    };
    const a = assess(d);
    return { ...d, level: a.level, reasons: a.reasons };
  });
}
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function diskHealth() {
  if (!IS_WIN) return [];
  const r = await powershell(PS, 60000);
  let rows;
  try { rows = JSON.parse(r.out || '[]'); } catch (e) { throw new Error('Не удалось прочитать данные дисков'); }
  if (!Array.isArray(rows)) rows = [rows];
  return normalize(rows.filter(Boolean));
}

const LEVEL_TEXT = { ok: 'исправен', warn: 'есть предупреждения', bad: 'требует внимания' };

module.exports = { diskHealth, assess, normalize, LEVEL_TEXT };
