'use strict';
// Здоровье дисков, как в CrystalDiskInfo: данные самодиагностики SMART читаются напрямую встроенным
// модулем smartmontools (smartctl.exe) и дополняются сведениями Windows (буквы разделов, свободное место).
// Тип диска (HDD / SSD / NVMe) определяется по скорости вращения: у жёсткого диска она есть, у SSD — 0.
// Только чтение, ничего на дисках не меняет.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { IS_WIN, powershell } = require('./exec');

// ---------------- сведения Windows ----------------
const PS = `
$disks = Get-PhysicalDisk | Sort-Object { [int]$_.DeviceId }
$fail = @{}
try { Get-CimInstance -Namespace root\\wmi -ClassName MSStorageDriver_FailurePredictStatus -ErrorAction Stop | ForEach-Object { $fail[$_.InstanceName] = $_.PredictFailure } } catch {}
$out = foreach ($d in $disks) {
  $r = $null
  try { $r = $d | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
  $parts = @()
  try {
    $parts = @(Get-Partition -DiskNumber ([int]$d.DeviceId) -ErrorAction Stop | Where-Object DriveLetter | ForEach-Object {
      $v = $null; try { $v = Get-Volume -DriveLetter $_.DriveLetter -ErrorAction Stop } catch {}
      [pscustomobject]@{ letter = [string]$_.DriveLetter + ':'; label = if ($v) { [string]$v.FileSystemLabel } else { '' }; size = if ($v) { [int64]$v.Size } else { [int64]$_.Size }; free = if ($v) { [int64]$v.SizeRemaining } else { $null }; fs = if ($v) { [string]$v.FileSystem } else { '' } }
    })
  } catch {}
  $pf = $false
  $sn = ([string]$d.SerialNumber).Trim()
  if ($sn) { foreach ($k in $fail.Keys) { if ($fail[$k] -and $k -match [regex]::Escape($sn)) { $pf = $true } } }
  [pscustomobject]@{
    id = [string]$d.DeviceId; model = [string]$d.FriendlyName; serial = $sn; firmware = [string]$d.FirmwareVersion
    media = [string]$d.MediaType; bus = [string]$d.BusType; size = [int64]$d.Size; spindle = $d.SpindleSpeed
    health = [string]$d.HealthStatus; status = (@($d.OperationalStatus) -join ', ')
    temp = if ($r) { $r.Temperature } else { $null }; tempMax = if ($r) { $r.TemperatureMax } else { $null }
    wear = if ($r) { $r.Wear } else { $null }; hours = if ($r) { $r.PowerOnHours } else { $null }
    readErrors = if ($r) { $r.ReadErrorsUncorrected } else { $null }; writeErrors = if ($r) { $r.WriteErrorsUncorrected } else { $null }
    startStop = if ($r) { $r.StartStopCycleCount } else { $null }
    predictFailure = $pf; parts = $parts
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4`;

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const UNKNOWN_SPINDLE = 4294967295;

/** Строка Get-PhysicalDisk → диск. */
function fromWindows(r) {
  const spindle = num(r.spindle);
  let kind = '';
  if (/nvme/i.test(r.bus)) kind = 'nvme';
  else if (spindle && spindle !== UNKNOWN_SPINDLE) kind = 'hdd';
  else if (/^hdd$/i.test(r.media)) kind = 'hdd';
  else if (/^ssd$/i.test(r.media) || spindle === 0) kind = 'ssd';
  if (/virtual/i.test(r.model || '')) kind = 'virtual';
  else if (!kind && /usb/i.test(r.bus)) kind = 'usb';
  const parts = (Array.isArray(r.parts) ? r.parts : r.parts ? [r.parts] : []).map((p) => ({
    letter: p.letter, label: p.label || '', size: num(p.size) || 0, free: num(p.free), fs: p.fs || '',
  }));
  return {
    index: num(r.id), id: String(r.id ?? ''), model: (r.model || '').trim(), serial: (r.serial || '').trim(), firmware: (r.firmware || '').trim(),
    bus: r.bus || '', size: num(r.size) || 0, kind, rpm: kind === 'hdd' && spindle && spindle !== UNKNOWN_SPINDLE ? spindle : null,
    winHealth: r.health || '', temp: num(r.temp) || null, tempMax: num(r.tempMax) || null,
    // Износ из Windows: у жёстких дисков он бессмысленный (всегда 0) — берём только для SSD
    wear: kind === 'ssd' || kind === 'nvme' ? num(r.wear) : null,
    hours: num(r.hours), readErrors: num(r.readErrors), writeErrors: num(r.writeErrors), startStop: num(r.startStop),
    predictFailure: !!r.predictFailure, parts,
  };
}

// ---------------- SMART через smartctl ----------------
const ATTR_RU = {
  1: 'Ошибки чтения', 2: 'Производительность', 3: 'Время раскрутки', 4: 'Запуски/остановки шпинделя', 5: 'Переназначенные сектора',
  7: 'Ошибки позиционирования', 8: 'Скорость позиционирования', 9: 'Часы работы', 10: 'Повторы раскрутки', 11: 'Повторы калибровки',
  12: 'Включения/выключения', 13: 'Программные ошибки чтения', 160: 'Неисправимые секторы', 161: 'Резервные блоки', 163: 'Начальные плохие блоки',
  164: 'Всего стёрто блоков', 165: 'Максимум стираний', 166: 'Минимум стираний', 167: 'Среднее стираний', 168: 'Ошибки PHY SATA',
  169: 'Оставшийся ресурс', 170: 'Резервные блоки', 171: 'Ошибки программирования', 172: 'Ошибки стирания', 173: 'Выравнивание износа',
  174: 'Внезапные отключения питания', 175: 'Ошибки программирования (макс.)', 176: 'Ошибки стирания (блоки)', 177: 'Выравнивание износа',
  178: 'Использовано резерва (чип)', 179: 'Использовано резервных блоков', 180: 'Неиспользованный резерв', 181: 'Ошибки программирования',
  182: 'Ошибки стирания', 183: 'Понижения скорости SATA', 184: 'Сквозные ошибки', 187: 'Неисправленные ошибки', 188: 'Таймауты команд',
  189: 'Запись при высоком положении головок', 190: 'Температура воздуха', 191: 'Ударные нагрузки', 192: 'Аварийные отключения питания',
  193: 'Циклы парковки головок', 194: 'Температура', 195: 'Исправленные ошибки ECC', 196: 'События переназначения', 197: 'Нестабильные сектора',
  198: 'Неисправимые сектора', 199: 'Ошибки передачи (кабель)', 200: 'Ошибки записи', 201: 'Программные ошибки чтения', 202: 'Оставшийся ресурс',
  203: 'Ошибки ECC', 204: 'Программная коррекция ECC', 206: 'Высота полёта головок', 210: 'Ошибки RAID', 220: 'Смещение пластин',
  222: 'Часы под нагрузкой', 223: 'Повторы загрузки головок', 224: 'Трение головок', 225: 'Циклы загрузки головок', 226: 'Время загрузки головок',
  227: 'Перегрузки по моменту', 228: 'Аварийные парковки', 230: 'Состояние головок / ресурс', 231: 'Оставшийся ресурс SSD',
  232: 'Резервные блоки', 233: 'Индикатор износа', 234: 'Всего записано во флеш', 235: 'Резервные блоки (свободно)', 240: 'Часы позиционирования головок',
  241: 'Всего записано', 242: 'Всего прочитано', 243: 'Всего записано (расш.)', 244: 'Среднее стираний', 245: 'Максимум стираний',
  246: 'Всего записано хостом', 247: 'Записано страниц хостом', 248: 'Записано страниц контроллером', 249: 'Записано во флеш (ГиБ)',
  250: 'Повторы чтения', 251: 'Минимум запасных блоков', 252: 'Сбросы счётчиков', 254: 'Защита от падения',
};

const hex = (id) => id.toString(16).toUpperCase().padStart(2, '0');

function findStat(devstat, re) {
  for (const page of (devstat && devstat.pages) || []) {
    for (const row of page.table || []) {
      if (re.test(row.name || '') && row.value != null && (!row.flags || row.flags.valid !== false)) return Number(row.value);
    }
  }
  return null;
}

/** Байты из атрибута «записано/прочитано» — единицы зависят от производителя, их выдаёт название. */
function attrBytes(a, block = 512) {
  if (!a || !a.raw) return null;
  const v = Number(a.raw.value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const n = a.name || '';
  let bytes;
  if (/32MiB/i.test(n)) bytes = v * 32 * 1048576;
  else if (/GiB|_GB/i.test(n)) bytes = v * 1073741824;
  else if (/MiB/i.test(n)) bytes = v * 1048576;
  else bytes = v * block;
  return bytes > 0 && bytes < 1e17 ? bytes : null;
}

/** Ответ `smartctl -j -a` → диск. */
function parseSmart(j) {
  if (!j || typeof j !== 'object') return null;
  const dev = j.device || {};
  const nvme = /nvme/i.test(dev.protocol || dev.type || '');
  const log = j.nvme_smart_health_information_log || null;
  const table = (j.ata_smart_attributes && j.ata_smart_attributes.table) || [];
  const attr = (id) => table.find((a) => a.id === id) || null;
  const raw = (id) => { const a = attr(id); if (!a || !a.raw) return null; const v = Number(a.raw.value); return Number.isFinite(v) ? v : null; };
  const norm = (id) => { const a = attr(id); return a && a.value != null && a.value <= 100 && a.value > 0 ? Number(a.value) : null; };
  const block = Number(j.logical_block_size) || 512;

  const rotation = j.rotation_rate;
  let kind = '';
  if (nvme) kind = 'nvme';
  else if (typeof rotation === 'number') kind = rotation > 0 ? 'hdd' : 'ssd';
  else if (attr(231) || attr(233) || attr(177) || attr(202) || attr(173)) kind = 'ssd';

  // Оставшийся ресурс SSD, % (как «Техсостояние» в CrystalDiskInfo)
  let life = null;
  if (log && log.percentage_used != null) life = Math.max(0, 100 - Number(log.percentage_used));
  if (life == null && kind === 'ssd') {
    const used = findStat(j.ata_device_statistics, /Percentage Used Endurance/i);
    if (used != null) life = Math.max(0, 100 - used);
    for (const id of [231, 233, 202, 169, 177, 173]) { if (life == null) life = norm(id); }
  }

  let written = null;
  let read = null;
  if (log) {
    if (log.data_units_written != null) written = Number(log.data_units_written) * 512000;
    if (log.data_units_read != null) read = Number(log.data_units_read) * 512000;
  } else {
    const ws = findStat(j.ata_device_statistics, /Logical Sectors Written/i);
    const rs = findStat(j.ata_device_statistics, /Logical Sectors Read/i);
    written = ws ? ws * block : attrBytes(attr(241), block) || attrBytes(attr(246), block);
    read = rs ? rs * block : attrBytes(attr(242), block);
  }

  const attrs = log
    ? nvmeRows(log)
    : table.map((a) => {
      const r = a.raw ? Number(a.raw.value) : null;
      let status = 'ok';
      if (a.when_failed === 'now' || (a.thresh > 0 && a.value <= a.thresh)) status = 'bad';
      else if (a.when_failed === 'past' || ([5, 10, 196, 197, 198].includes(a.id) && r > 0)) status = 'warn';
      return { id: hex(a.id), name: ATTR_RU[a.id] || String(a.name || '').replace(/_/g, ' '), en: a.name || '', value: a.value, worst: a.worst, thresh: a.thresh, raw: a.raw ? a.raw.string : '', status };
    });

  const cap = (j.user_capacity && j.user_capacity.bytes) || j.nvme_total_capacity || 0;
  const speed = j.interface_speed || {};
  return {
    device: dev.name || '', smartType: dev.type || '', protocol: dev.protocol || '',
    model: (j.model_name || j.scsi_model_name || '').trim(), family: j.model_family || '', serial: (j.serial_number || '').trim(),
    firmware: (j.firmware_version || '').trim(), size: Number(cap) || 0, kind, rpm: typeof rotation === 'number' && rotation > 1 ? rotation : null,
    formFactor: (j.form_factor && j.form_factor.name) || '',
    link: speed.current && speed.current.string ? `${speed.current.string}${speed.max && speed.max.string && speed.max.string !== speed.current.string ? ` (макс. ${speed.max.string})` : ''}` : '',
    trim: j.trim ? !!j.trim.supported : null,
    smartAvailable: j.smart_support ? j.smart_support.available !== false : !!(log || table.length),
    smartPassed: j.smart_status && typeof j.smart_status.passed === 'boolean' ? j.smart_status.passed : null,
    life,
    temp: num(j.temperature && j.temperature.current) ?? num(log && log.temperature) ?? raw(194),
    tempMax: num(j.temperature && j.temperature.lifetime_max),
    hours: num(j.power_on_time && j.power_on_time.hours) ?? num(log && log.power_on_hours) ?? raw(9),
    powerCycles: num(j.power_cycle_count) ?? num(log && log.power_cycles) ?? raw(12),
    written, read,
    unsafeShutdowns: log ? num(log.unsafe_shutdowns) : kind === 'ssd' ? raw(174) : null,
    reallocated: log ? null : raw(5), pending: log ? null : raw(197), uncorrectable: log ? null : raw(198),
    crcErrors: log ? null : raw(199), spinRetry: log ? null : raw(10),
    mediaErrors: log ? num(log.media_errors) : null, criticalWarning: log ? num(log.critical_warning) : null,
    spare: log ? num(log.available_spare) : null, spareThreshold: log ? num(log.available_spare_threshold) : null,
    attrs,
  };
}

function nvmeRows(l) {
  const TB = (u) => (u == null ? '' : `${(Number(u) * 512000 / 1e12).toFixed(2)} ТБ`);
  const rows = [
    ['01', 'Критические предупреждения', l.critical_warning, l.critical_warning ? 'bad' : 'ok'],
    ['02', 'Температура', l.temperature != null ? `${l.temperature} °C` : null],
    ['03', 'Свободный резерв', l.available_spare != null ? `${l.available_spare}%` : null, l.available_spare != null && l.available_spare <= (l.available_spare_threshold || 0) ? 'bad' : 'ok'],
    ['04', 'Порог резерва', l.available_spare_threshold != null ? `${l.available_spare_threshold}%` : null],
    ['05', 'Использовано ресурса', l.percentage_used != null ? `${l.percentage_used}%` : null, l.percentage_used >= 90 ? 'warn' : 'ok'],
    ['06', 'Прочитано данных', TB(l.data_units_read)],
    ['07', 'Записано данных', TB(l.data_units_written)],
    ['08', 'Команд чтения', l.host_reads],
    ['09', 'Команд записи', l.host_writes],
    ['0A', 'Время занятости контроллера', l.controller_busy_time != null ? `${l.controller_busy_time} мин` : null],
    ['0B', 'Включений', l.power_cycles],
    ['0C', 'Часов работы', l.power_on_hours],
    ['0D', 'Небезопасных отключений', l.unsafe_shutdowns],
    ['0E', 'Ошибки носителя', l.media_errors, l.media_errors > 0 ? 'warn' : 'ok'],
    ['0F', 'Записей в журнале ошибок', l.num_err_log_entries],
    ['10', 'Время при высокой температуре', l.warning_temp_time != null ? `${l.warning_temp_time} мин` : null],
    ['11', 'Время при критической температуре', l.critical_comp_time != null ? `${l.critical_comp_time} мин` : null, l.critical_comp_time > 0 ? 'warn' : 'ok'],
  ];
  return rows.filter((r) => r[2] != null && r[2] !== '').map(([id, name, v, status]) => ({ id, name, raw: String(v), status: status || 'ok' }));
}

// ---------------- объединение и оценка ----------------
const normSerial = (s) => String(s || '').replace(/[^0-9a-z]/gi, '').toUpperCase();
function sdIndex(name) {
  const m = /\/dev\/sd([a-z]+)$/i.exec(name || '');
  if (!m) return null;
  return [...m[1].toLowerCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 96), 0) - 1;
}

/** Сводит данные Windows и SMART в один список (сопоставление по серийному номеру, номеру диска, модели). */
function merge(win, smart) {
  const used = new Set();
  const out = win.map((w) => {
    let s = smart.find((x, i) => !used.has(i) && x.serial && w.serial && (normSerial(x.serial) === normSerial(w.serial) || normSerial(w.serial).includes(normSerial(x.serial))));
    if (!s) s = smart.find((x, i) => !used.has(i) && sdIndex(x.device) != null && sdIndex(x.device) === w.index);
    if (!s) s = smart.find((x, i) => !used.has(i) && x.model && w.model && w.model.toUpperCase().includes(x.model.toUpperCase()) && (!x.size || !w.size || Math.abs(x.size - w.size) / w.size < 0.02));
    if (s) used.add(smart.indexOf(s));
    return combine(w, s || null);
  });
  smart.forEach((s, i) => { if (!used.has(i)) out.push(combine(null, s)); });
  return out;
}

function combine(w, s) {
  const pick = (k) => (s && s[k] != null && s[k] !== '' ? s[k] : w && w[k] != null && w[k] !== '' ? w[k] : null);
  let kind = (s && s.kind) || (w && w.kind) || '';
  if (w && w.kind === 'virtual') kind = 'virtual';
  else if (kind !== 'hdd' && w && /usb/i.test(w.bus) && !s) kind = kind || 'usb';
  const life = s && s.life != null ? s.life : w && w.wear != null && (kind === 'ssd' || kind === 'nvme') ? Math.max(0, 100 - w.wear) : null;
  const d = {
    id: w ? w.id : s.device, model: pick('model') || 'Диск', family: (s && s.family) || '', serial: pick('serial') || '', firmware: pick('firmware') || '',
    size: (w && w.size) || (s && s.size) || 0, kind, rpm: pick('rpm'), bus: (w && w.bus) || (s && s.protocol) || '',
    formFactor: (s && s.formFactor) || '', link: (s && s.link) || '', trim: s ? s.trim : null,
    smart: !!(s && s.smartAvailable), smartPassed: s ? s.smartPassed : null, winHealth: (w && w.winHealth) || '',
    life, wear: life != null ? 100 - life : null,
    temp: pick('temp'), tempMax: pick('tempMax'), hours: pick('hours'), powerCycles: s ? s.powerCycles : w ? w.startStop : null,
    written: s ? s.written : null, read: s ? s.read : null, unsafeShutdowns: s ? s.unsafeShutdowns : null,
    reallocated: s ? s.reallocated : null, pending: s ? s.pending : null, uncorrectable: s ? s.uncorrectable : null,
    crcErrors: s ? s.crcErrors : null, spinRetry: s ? s.spinRetry : null, mediaErrors: s ? s.mediaErrors : null,
    criticalWarning: s ? s.criticalWarning : null, spare: s ? s.spare : null, spareThreshold: s ? s.spareThreshold : null,
    readErrors: w ? w.readErrors : null, writeErrors: w ? w.writeErrors : null, predictFailure: !!(w && w.predictFailure),
    parts: (w && w.parts) || [], attrs: (s && s.attrs) || [],
  };
  d.volumes = d.parts.map((p) => p.letter).join(' ');
  d.media = KIND_SHORT[kind] || '';
  d.kindText = KIND_TEXT[kind] || 'Диск';
  return Object.assign(d, assess(d));
}

const KIND_SHORT = { hdd: 'HDD', ssd: 'SSD', nvme: 'NVMe SSD', usb: 'USB', virtual: 'Виртуальный' };
const KIND_TEXT = { hdd: 'Жёсткий диск (HDD)', ssd: 'SSD', nvme: 'NVMe SSD', usb: 'USB-накопитель', virtual: 'Виртуальный диск' };

/**
 * Итоговая оценка, как в CrystalDiskInfo: ok («Хорошо») | warn («Тревога») | bad («Плохо»).
 * reasons — почему не «Хорошо»; notes — полезные замечания, которые не меняют оценку.
 */
function assess(d) {
  const reasons = [];
  const notes = [];
  let level = 'ok';
  const bump = (l, why) => { reasons.push(why); if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
  const ssd = /ssd|nvme/i.test(`${d.kind || ''} ${d.media || ''} ${d.bus || ''}`);
  if (d.smartPassed === false) bump('bad', 'самодиагностика SMART диска не пройдена');
  if (d.predictFailure) bump('bad', 'диск сам сообщает о скорой поломке (SMART)');
  for (const a of d.attrs || []) {
    if (a.status === 'bad' && a.value != null) bump('bad', `атрибут ${a.id} «${a.name}» ниже допустимого порога`);
  }
  const health = d.health || d.winHealth || '';
  if (/unhealthy/i.test(health)) bump('bad', 'Windows считает диск неисправным');
  else if (/warning/i.test(health)) bump('warn', 'Windows предупреждает о проблемах с диском');
  if (d.reallocated > 0) bump('warn', `переназначенные сектора: ${d.reallocated} — поверхность начала портиться`);
  if (d.pending > 0) bump('warn', `нестабильные сектора: ${d.pending} — есть места, которые читаются с трудом`);
  if (d.uncorrectable > 0) bump('warn', `неисправимые сектора: ${d.uncorrectable}`);
  if (d.spinRetry > 0) bump('warn', `повторы раскрутки шпинделя: ${d.spinRetry}`);
  if (d.mediaErrors > 0) bump('warn', `ошибки носителя: ${d.mediaErrors}`);
  if (d.criticalWarning) {
    if (d.criticalWarning & 0x0d) bump('bad', 'SSD сообщает о критическом состоянии (резерв, надёжность или только чтение)');
    else bump('warn', 'SSD сообщает о предупреждении (температура или резервное питание)');
  }
  if (d.spare != null && d.spareThreshold != null && d.spareThreshold > 0 && d.spare <= d.spareThreshold) bump('bad', `резерв SSD исчерпан: ${d.spare}%`);
  if (d.readErrors > 0 || d.writeErrors > 0) bump(d.readErrors > 10 ? 'bad' : 'warn', `неисправленные ошибки чтения/записи: ${(d.readErrors || 0) + (d.writeErrors || 0)}`);
  const life = d.life != null ? d.life : d.wear != null && ssd ? 100 - d.wear : null;
  if (life != null) {
    if (life <= 10) bump('bad', `ресурс SSD почти исчерпан (осталось ${life}%)`);
    else if (life <= 30) bump('warn', `SSD заметно изношен (осталось ${life}% ресурса)`);
  }
  if (d.temp != null) {
    // Пороги как у производителей: NVMe обычно греются до 70°C и сбрасывают частоту около 80–85°C
    const nvme = /nvme/i.test(`${d.kind || ''} ${d.media || ''} ${d.bus || ''}`);
    const [warn, bad] = nvme ? [80, 85] : ssd ? [70, 80] : [55, 65];
    if (d.temp >= bad) bump('bad', `перегрев: ${d.temp}°C`);
    else if (d.temp >= warn) bump('warn', `высокая температура: ${d.temp}°C`);
  }
  if (d.crcErrors > 0) notes.push(`были ошибки передачи данных по кабелю (${d.crcErrors}). Если число растёт — замените SATA-кабель или порт.`);
  return { level, reasons, notes };
}

/** Совместимость: строки Get-PhysicalDisk → диски с оценкой (без SMART). */
function normalize(rows) {
  return rows.map((r) => combine(fromWindows(r), null));
}

// ---------------- запуск ----------------
function smartctlPath() {
  const name = IS_WIN ? 'smartctl.exe' : 'smartctl';
  const cands = [
    process.env.PCFC_SMARTCTL,
    process.resourcesPath && path.join(process.resourcesPath, 'bin', name),
    path.join(__dirname, '..', '..', '..', 'build', 'bin', name),
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || null;
}

/** smartctl с JSON-выводом; код возврата — битовая маска, поэтому разбираем вывод в любом случае. */
function smartctl(exe, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(exe, ['-j', ...args], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      try { resolve(JSON.parse(String(stdout || ''))); } catch (e) { resolve(null); }
    });
  });
}

async function smartDisks(exe) {
  const scan = await smartctl(exe, ['--scan-open'], 60000);
  const devs = ((scan && scan.devices) || []).filter((d) => d && d.name && !d.open_error);
  const out = [];
  for (const d of devs) {
    const args = ['-a'];
    if (/ata|sat/i.test(`${d.protocol} ${d.type}`) && !/nvme/i.test(d.type || '')) args.push('-l', 'devstat');
    if (d.type) args.push('-d', d.type);
    args.push(d.name);
    const j = await smartctl(exe, args);
    const s = parseSmart(j);
    // Один и тот же диск может попасть в список дважды под разными именами
    if (s && (s.model || s.serial) && !(s.serial && out.some((x) => x.serial === s.serial))) out.push(s);
  }
  return out;
}

async function windowsDisks() {
  const r = await powershell(PS, 60000);
  let rows;
  try { rows = JSON.parse(r.out || '[]'); } catch (e) { throw new Error('Не удалось прочитать данные дисков'); }
  if (!Array.isArray(rows)) rows = [rows];
  return rows.filter(Boolean).map(fromWindows);
}

async function diskHealth() {
  if (!IS_WIN && !process.env.PCFC_SMARTCTL) return [];
  const exe = smartctlPath();
  const [win, smart] = await Promise.all([
    IS_WIN ? windowsDisks() : Promise.resolve([]),
    exe ? smartDisks(exe).catch(() => []) : Promise.resolve([]),
  ]);
  return merge(win, smart);
}

const LEVEL_TEXT = { ok: 'исправен', warn: 'есть предупреждения', bad: 'требует внимания' };

module.exports = { diskHealth, assess, normalize, parseSmart, merge, fromWindows, sdIndex, LEVEL_TEXT, KIND_TEXT };
