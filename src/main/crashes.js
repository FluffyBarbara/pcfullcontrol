'use strict';
// Аварийные перезагрузки: «синие экраны» (BugCheck) и внезапные выключения (Kernel-Power 41).
// Данные — журнал «Система» Windows; каждая ошибка объясняется простыми словами с советом, что делать.
// Если компьютер упал — после перезагрузки бот присылает причину.
const fs = require('fs');
const path = require('path');
const { IS_WIN, run } = require('./system/exec');
const { E } = require('./telegram-api');

const ADVICE = {
  driver: 'Обновите драйверы — особенно видеокарты, сети/Wi-Fi и чипсета, — и программы, которые ставят свои драйверы: антивирусы, VPN, утилиты подсветки и разгона. Если сбои начались после установки чего-то нового — удалите это.',
  memory: 'Проверьте оперативную память: «Средство проверки памяти Windows» (Win+R → mdsched) или MemTest86. Если в BIOS включён XMP/EXPO или разгон — отключите и понаблюдайте.',
  hardware: 'Похоже на проблему с железом: перегрев, нестабильный разгон или нехватка питания. Посмотрите графики температур в разделе «Железо», сбросьте разгон в BIOS, обновите BIOS, проверьте блок питания.',
  disk: 'Проверьте диск: здоровье — в разделе «Железо», затем в командной строке от администратора — chkdsk C: /f. Для SATA-дисков проверьте кабель и разъём.',
  gpu: 'Видеокарта: переустановите драйвер начисто (утилита DDU), уберите разгон, проверьте её температуру и дополнительное питание.',
  system: 'Восстановите системные файлы: в командной строке от администратора выполните sfc /scannow, затем DISM /Online /Cleanup-Image /RestoreHealth.',
  power: 'Если повторяется под нагрузкой (игры, рендер) — проверьте блок питания и температуры. Если в момент сбоя пропадал свет — это не неисправность компьютера.',
  manual: 'Сбой вызвали вручную (удержание кнопки или специальная команда) — это не неисправность.',
};

// Код → [название, объяснение, тип совета]
const CODES = {
  0x0A: ['IRQL_NOT_LESS_OR_EQUAL', 'Драйвер обратился к памяти в неподходящий момент.', 'driver'],
  0x19: ['BAD_POOL_HEADER', 'Повреждены служебные данные памяти ядра — обычно из-за драйвера, реже из-за ОЗУ.', 'driver'],
  0x1A: ['MEMORY_MANAGEMENT', 'Ошибка управления памятью — часто неисправная или нестабильная оперативная память.', 'memory'],
  0x1E: ['KMODE_EXCEPTION_NOT_HANDLED', 'Драйвер выполнил недопустимую операцию.', 'driver'],
  0x24: ['NTFS_FILE_SYSTEM', 'Ошибка файловой системы диска.', 'disk'],
  0x3B: ['SYSTEM_SERVICE_EXCEPTION', 'Ошибка в драйвере или системном компоненте (часто — видеодрайвер или антивирус).', 'driver'],
  0x3D: ['INTERRUPT_EXCEPTION_NOT_HANDLED', 'Драйвер устройства не обработал прерывание.', 'driver'],
  0x4E: ['PFN_LIST_CORRUPT', 'Повреждён список страниц памяти — оперативная память или драйвер.', 'memory'],
  0x50: ['PAGE_FAULT_IN_NONPAGED_AREA', 'Обращение к несуществующей памяти — драйвер, антивирус или неисправная ОЗУ.', 'memory'],
  0x77: ['KERNEL_STACK_INPAGE_ERROR', 'Не удалось прочитать данные с диска (файл подкачки).', 'disk'],
  0x7A: ['KERNEL_DATA_INPAGE_ERROR', 'Не удалось прочитать данные с диска — диск, кабель или файл подкачки.', 'disk'],
  0x7E: ['SYSTEM_THREAD_EXCEPTION_NOT_HANDLED', 'Сбой в системном потоке — почти всегда драйвер.', 'driver'],
  0x7F: ['UNEXPECTED_KERNEL_MODE_TRAP', 'Процессор поймал аппаратную ошибку — ОЗУ, перегрев или разгон.', 'hardware'],
  0x8E: ['KERNEL_MODE_EXCEPTION_NOT_HANDLED', 'Необработанная ошибка в драйвере.', 'driver'],
  0x9C: ['MACHINE_CHECK_EXCEPTION', 'Процессор сообщил об аппаратной ошибке.', 'hardware'],
  0x9F: ['DRIVER_POWER_STATE_FAILURE', 'Драйвер не справился со сном или пробуждением компьютера (часто сеть, видео, USB).', 'driver'],
  0xA0: ['INTERNAL_POWER_ERROR', 'Ошибка управления питанием (сон, гибернация).', 'driver'],
  0xBE: ['ATTEMPTED_WRITE_TO_READONLY_MEMORY', 'Драйвер попытался записать в защищённую память.', 'driver'],
  0xC2: ['BAD_POOL_CALLER', 'Драйвер неправильно работает с памятью.', 'driver'],
  0xC5: ['DRIVER_CORRUPTED_EXPOOL', 'Драйвер повредил память ядра.', 'driver'],
  0xD1: ['DRIVER_IRQL_NOT_LESS_OR_EQUAL', 'Драйвер обратился к памяти в неподходящий момент (часто сетевой/Wi-Fi, антивирус, VPN).', 'driver'],
  0xE2: ['MANUALLY_INITIATED_CRASH', 'Сбой вызван вручную.', 'manual'],
  0xEA: ['THREAD_STUCK_IN_DEVICE_DRIVER', 'Драйвер видеокарты завис в бесконечном цикле.', 'gpu'],
  0xEF: ['CRITICAL_PROCESS_DIED', 'Неожиданно завершился важный процесс Windows — повреждены системные файлы, сбоит диск или вирус.', 'system'],
  0xF4: ['CRITICAL_OBJECT_TERMINATION', 'Завершился критически важный процесс — часто сбоит диск/SSD или его кабель.', 'disk'],
  0xFC: ['ATTEMPTED_EXECUTE_OF_NOEXECUTE_MEMORY', 'Драйвер попытался выполнить код из защищённой памяти.', 'driver'],
  0xFE: ['BUGCODE_USB_DRIVER', 'Ошибка драйвера USB — попробуйте отключить USB-устройства по одному.', 'driver'],
  0x101: ['CLOCK_WATCHDOG_TIMEOUT', 'Одно из ядер процессора перестало отвечать — разгон, питание, перегрев или BIOS.', 'hardware'],
  0x109: ['CRITICAL_STRUCTURE_CORRUPTION', 'Повреждены важные структуры ядра — драйвер, неисправная ОЗУ или вредоносная программа.', 'memory'],
  0x10D: ['WDF_VIOLATION', 'Ошибка драйвера устройства (часто USB-устройство).', 'driver'],
  0x113: ['VIDEO_DXGKRNL_FATAL_ERROR', 'Сбой графической подсистемы Windows.', 'gpu'],
  0x116: ['VIDEO_TDR_FAILURE', 'Видеокарта перестала отвечать и не восстановилась — драйвер, перегрев, разгон или питание видеокарты.', 'gpu'],
  0x117: ['VIDEO_TDR_TIMEOUT_DETECTED', 'Видеокарта не ответила вовремя.', 'gpu'],
  0x119: ['VIDEO_SCHEDULER_INTERNAL_ERROR', 'Ошибка планировщика видеокарты — драйвер видеокарты.', 'gpu'],
  0x124: ['WHEA_UNCORRECTABLE_ERROR', 'Неисправимая аппаратная ошибка — процессор, память, питание, перегрев или разгон.', 'hardware'],
  0x133: ['DPC_WATCHDOG_VIOLATION', 'Драйвер или устройство слишком долго не отвечало (часто драйвер SSD/SATA или его прошивка).', 'driver'],
  0x139: ['KERNEL_SECURITY_CHECK_FAILURE', 'Ядро обнаружило повреждение данных — драйвер, память или системные файлы.', 'driver'],
  0x13A: ['KERNEL_MODE_HEAP_CORRUPTION', 'Драйвер повредил память ядра.', 'driver'],
  0x144: ['BUGCODE_USB3_DRIVER', 'Ошибка драйвера USB 3.', 'driver'],
  0x14F: ['PDC_WATCHDOG_TIMEOUT', 'Система не дождалась ответа при сне/пробуждении.', 'driver'],
  0x154: ['UNEXPECTED_STORE_EXCEPTION', 'Ошибка при работе с хранилищем памяти — диск/SSD или ОЗУ.', 'disk'],
  0x1C8: ['MANUALLY_INITIATED_POWER_BUTTON_HOLD', 'Удерживали кнопку питания — Windows сохранила снимок памяти.', 'manual'],
  0xC000021A: ['STATUS_SYSTEM_PROCESS_TERMINATED', 'Завершился важный системный процесс — повреждены системные файлы или драйвер.', 'system'],
};

/** Код из события (шестнадцатеричный или десятичный) → число; 0x1000007E и т. п. = 0x7E. */
function normCode(raw) {
  let s = String(raw || '').trim();
  let n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  if (n > 0x10000000 && n < 0x10001000) n &= 0xFFF;
  return n;
}

function explain(code) {
  const hex = '0x' + code.toString(16).toUpperCase().padStart(8, '0');
  const c = CODES[code];
  if (!c) return { code: hex, name: '', title: 'Синий экран', text: 'Windows аварийно остановилась. Чаще всего причина — драйвер или неисправность железа.', advice: ADVICE.driver, cause: 'driver' };
  return { code: hex, name: c[0], title: 'Синий экран', text: c[1], advice: ADVICE[c[2]], cause: c[2] };
}

/** XML событий wevtutil → список { id, provider, eventId, time, data }. */
function parseEvents(xml) {
  const out = [];
  const re = /<Event[\s\S]*?<\/Event>/g;
  let m;
  while ((m = re.exec(String(xml)))) {
    const ev = m[0];
    const provider = (/Provider Name=['"]([^'"]+)['"]/.exec(ev) || [])[1] || '';
    const eventId = Number((/<EventID[^>]*>(\d+)<\/EventID>/.exec(ev) || [])[1] || 0);
    const id = Number((/<EventRecordID>(\d+)<\/EventRecordID>/.exec(ev) || [])[1] || 0);
    const time = (/SystemTime=['"]([^'"]+)['"]/.exec(ev) || [])[1] || '';
    const data = {};
    const dre = /<Data(?: Name=['"]([^'"]+)['"])?\s*(?:\/>|>([\s\S]*?)<\/Data>)/g;
    let d;
    let i = 0;
    while ((d = dre.exec(ev))) data[d[1] || `p${++i}`] = (d[2] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    out.push({ id, provider, eventId, time, ts: Date.parse(time) / 1000 || 0, data });
  }
  return out;
}

/** События → аварии: BugCheck и Kernel-Power 41 об одном сбое объединяются. */
function buildCrashes(events) {
  const list = [];
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  for (const e of sorted) {
    if (e.eventId === 1001 && /SystemErrorReporting/i.test(e.provider)) {
      const raw = e.data.param1 || e.data.p1 || '';
      const code = normCode((/^(0x[0-9a-f]+)/i.exec(raw) || [])[1]);
      if (code == null) continue;
      const near = list.find((c) => Math.abs(c.ts - e.ts) < 900 && (c.kind === 'power' || c.codeNum === code));
      const info = { ...explain(code), kind: 'bsod', codeNum: code, params: (/\(([^)]*)\)/.exec(raw) || [])[1] || '', dump: e.data.param2 || e.data.p2 || '', id: e.id, ts: near ? Math.min(near.ts, e.ts) : e.ts };
      if (near) Object.assign(near, info); else list.push(info);
    } else if (e.eventId === 41 && /Kernel-Power/i.test(e.provider)) {
      const code = normCode(e.data.BugcheckCode);
      if (list.some((c) => Math.abs(c.ts - e.ts) < 900)) continue;
      if (code) list.push({ ...explain(code), kind: 'bsod', codeNum: code, params: '', dump: '', id: e.id, ts: e.ts });
      else {
        const button = Number(e.data.PowerButtonTimestamp) > 0;
        list.push({ kind: 'power', id: e.id, ts: e.ts, code: '', name: '', title: 'Внезапное выключение',
          text: button ? 'Компьютер выключили удержанием кнопки питания.' : 'Компьютер выключился без завершения работы: пропало питание, сработала защита блока питания, перегрев или зависание с перезагрузкой кнопкой.',
          advice: button ? 'Если пришлось держать кнопку из-за зависания — посмотрите температуры и драйверы.' : ADVICE.power, cause: 'power' });
      }
    }
  }
  return list.sort((a, b) => b.ts - a.ts);
}

class CrashWatch {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
  }

  async list(days = 90) {
    if (!IS_WIN) return [];
    const q = `*[System[((EventID=1001 and Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting']) or (EventID=41 and Provider[@Name='Microsoft-Windows-Kernel-Power'])) and TimeCreated[timediff(@SystemTime) <= ${days * 86400000}]]]`;
    const r = await run('wevtutil.exe', ['qe', 'System', `/q:${q}`, '/f:xml', '/rd:true', '/c:100'], { timeout: 30000 });
    if (r.code !== 0) return [];
    const crashes = buildCrashes(parseEvents(r.out));
    // Файлы мини-дампов рядом по времени — пригодятся мастеру
    let dumps = [];
    try {
      const dir = path.join(process.env.SystemRoot || 'C:\\Windows', 'Minidump');
      dumps = fs.readdirSync(dir).map((f) => ({ file: path.join(dir, f), ts: fs.statSync(path.join(dir, f)).mtimeMs / 1000 }));
    } catch (e) { /* нет папки */ }
    for (const c of crashes) {
      if (c.kind !== 'bsod') continue;
      const d = dumps.find((x) => Math.abs(x.ts - c.ts) < 3600);
      if (d) c.minidump = d.file;
    }
    return crashes;
  }

  /** После запуска: была ли авария с прошлого раза — сообщаем в Telegram. */
  async checkNew() {
    const crashes = await this.list(14);
    const last = this.ctx.db.getSetting('lastCrashId') || 0;
    const fresh = crashes.filter((c) => c.id > last);
    if (crashes.length) this.ctx.db.setSetting('lastCrashId', Math.max(last, ...crashes.map((c) => c.id)));
    if (!last) return; // первый запуск — старое не присылаем
    for (const c of fresh.slice(0, 3)) {
      const when = new Date(c.ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      this.ctx.notifier.notify(`${c.kind === 'bsod' ? '💥' : '⚡'} <b>${E(c.title)}</b> — ${when}\n${c.code ? `Код: <code>${E(c.code)}</code> ${E(c.name)}\n` : ''}${E(c.text)}\n\n💡 ${E(c.advice)}`,
        { category: 'system', level: 'warning' });
    }
  }

  start() {
    if (!IS_WIN) return;
    setTimeout(() => this.checkNew().catch(() => {}), 60000);
    this.timer = setInterval(() => this.checkNew().catch(() => {}), 6 * 3600 * 1000);
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { CrashWatch, parseEvents, buildCrashes, explain, normCode };
