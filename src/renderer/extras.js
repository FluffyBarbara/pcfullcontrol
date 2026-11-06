'use strict';
// Разделы «Железо» (видеокарта, FPS, диски), «Сеть» (интернет, скорость, устройства, доступ из интернета)
// и вкладка «Автозагрузка» в «Оптимизации».
const Extras = (() => {
  const LEVEL = { ok: ['ok', 'Исправен', 'check'], warn: ['warn', 'Есть предупреждения', 'alert'], bad: ['err', 'Требует внимания', 'alert'] };
  const pct = (v) => (v == null ? '—' : Math.round(v) + '%');

  // ---------------- железо ----------------
  function gauge(label, value, max, text, tone = '') {
    const p = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
    const fill = el('i');
    fill.style.width = p + '%';
    return el('div', { class: 'hw-gauge ' + tone }, el('div', { class: 'hw-gauge-top' }, el('span', { text: label }), el('b', { text })), el('div', { class: 'bar' }, fill));
  }

  function renderGpu(r) {
    const box = $('#hw-gpus');
    if (!r || !r.gpus || !r.gpus.length) {
      box.replaceChildren(el('div', { class: 'card empty-card' }, ic('gpu', 28), el('p', { class: 'muted', text: 'Видеокарта не найдена или не отдаёт данные. Для видеокарт NVIDIA данные есть всегда, для остальных — то, что сообщает Windows.' })));
      return;
    }
    box.replaceChildren(...r.gpus.map((g, i) => {
      const hot = g.temp != null && g.temp >= 80;
      const fps = i === 0 ? r.fps : null;
      const fpsBox = i !== 0 ? null : el('div', { class: 'fps-box' + (fps ? '' : ' idle') },
        el('div', { class: 'fps-num', text: fps ? String(fps.fps) : '—' }), el('div', { class: 'fps-lbl', text: 'кадров в секунду' }),
        el('div', { class: 'fps-app', text: fps ? `${fps.app.replace(/\.exe$/i, '')} · 1% низких ${fps.low1}` : r.fpsAvailable ? 'Запустите игру — счётчик появится сам' : 'Счётчик кадров недоступен' }));
      const rows = [
        ['Частота ядра', g.clock != null ? `${Math.round(g.clock)} МГц${g.clockMax ? ` из ${Math.round(g.clockMax)}` : ''}` : null],
        ['Частота памяти', g.memClock != null ? `${Math.round(g.memClock)} МГц` : null],
        ['Мощность', g.power != null ? `${Math.round(g.power)} Вт${g.powerLimit ? ` из ${Math.round(g.powerLimit)}` : ''}` : null],
        ['Вентилятор', g.fan != null ? `${Math.round(g.fan)}%` : null],
        ['Драйвер', g.driver || null],
      ].filter((x) => x[1]);
      return el('div', { class: 'card gpu-card' },
        el('div', { class: 'gpu-head' }, el('div', { class: 'gpu-ic' + (hot ? ' hot' : '') }, ic('gpu', 26)),
          el('div', { class: 'spacer' }, el('h3', { text: g.name }), el('p', { class: 'muted small', text: g.vendor || '' })),
          g.temp != null ? el('div', { class: 'gpu-temp' + (hot ? ' hot' : ''), text: `${Math.round(g.temp)}°C` }) : null),
        el('div', { class: 'gpu-body' },
          el('div', { class: 'gpu-gauges' },
            gauge('Загрузка', g.util, 100, pct(g.util), g.util >= 90 ? 'hot' : ''),
            gauge('Видеопамять', g.memUsed, g.memTotal || 1, g.memTotal ? `${fmtBytes(g.memUsed || 0)} из ${fmtBytes(g.memTotal)}` : '—'),
            g.temp != null ? gauge('Температура', g.temp, 100, `${Math.round(g.temp)}°C`, hot ? 'hot' : '') : null,
            el('div', { class: 'gpu-rows' }, rows.map(([k, v]) => el('div', { class: 'kv' }, el('span', { text: k }), el('b', { text: v }))))),
          fpsBox));
    }));
  }

  // ---------------- диски (как в CrystalDiskInfo) ----------------
  const DISK_LEVEL = { ok: ['ok', 'Хорошо', 'check'], warn: ['warn', 'Тревога', 'alert'], bad: ['err', 'Плохо', 'alert'] };
  const KIND_IC = { hdd: 'hdd', ssd: 'ssd', nvme: 'nvme', usb: 'disk', virtual: 'disk' };
  const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU');
  function fmtHours(h) {
    if (h == null) return '—';
    const d = Math.floor(h / 24);
    if (d >= 365) { const y = Math.floor(d / 365); const m = Math.floor((d % 365) / 30.4); return `${y} г.${m ? ` ${m} мес.` : ''}`; }
    return d >= 1 ? `${d} дн.` : `${Math.round(h)} ч`;
  }
  const fmtTB = (b) => (b == null ? null : b >= 1e12 ? `${(b / 1e12).toFixed(2)} ТБ` : `${(b / 1e9).toFixed(1)} ГБ`);
  const fmtSize = (b) => (!b ? '—' : b >= 1e12 ? `${(b / 1e12).toFixed(b >= 1e13 ? 0 : 1)} ТБ` : `${Math.round(b / 1e9)} ГБ`);
  const TEMP_LIM = { hdd: [46, 55], ssd: [60, 70], nvme: [70, 80] };
  const tempTone = (d) => { if (d.temp == null) return ''; const [mid, hot] = TEMP_LIM[d.kind] || TEMP_LIM.ssd; return d.temp >= hot ? 'hot' : d.temp >= mid ? 'mid' : 'cool'; };

  function diskSub(d) {
    return [d.kindText, d.rpm ? `${fmtNum(d.rpm)} об/мин` : null, d.bus && !/^nvme$/i.test(d.bus) ? d.bus : null, d.link ? d.link.replace('Gb/s', 'Гбит/с') : null, fmtSize(d.size)]
      .filter(Boolean).join(' · ');
  }

  function healthRing(d, tone) {
    const hasLife = d.life != null;
    const ring = el('div', { class: 'dh-ring ' + tone + (hasLife ? '' : ' word'), 'data-tip': hasLife ? 'Оставшийся ресурс SSD: сколько ещё можно записать до износа ячеек' : 'Общая оценка состояния по данным SMART' },
      el('div', { class: 'dh-ring-in' }, el('b', { text: hasLife ? `${d.life}%` : DISK_LEVEL[d.level][1] }), el('span', { text: hasLife ? DISK_LEVEL[d.level][1] : 'состояние' })));
    ring.style.setProperty('--p', hasLife ? d.life : 100);
    return ring;
  }

  function tile(icon, label, value, tone = '', tip = '') {
    return el('div', { class: 'dh-tile ' + tone, 'data-tip': tip || null }, el('div', { class: 'dh-tile-top' }, ic(icon, 14), el('span', { text: label })), el('b', { text: value }));
  }

  function smartTable(d) {
    const nvme = d.attrs.length && d.attrs[0].value === undefined;
    const head = nvme ? ['', 'ID', 'Параметр', 'Значение'] : ['', 'ID', 'Атрибут', 'Текущее', 'Худшее', 'Порог', 'Raw'];
    const rows = d.attrs.map((a) => el('tr', { class: a.status },
      el('td', {}, el('span', { class: 'dh-dot ' + a.status })), el('td', { class: 'mono', text: a.id }),
      el('td', { title: a.en || '' , text: a.name }),
      ...(nvme ? [el('td', { class: 'mono', text: a.raw })] : [el('td', { text: a.value ?? '' }), el('td', { text: a.worst ?? '' }), el('td', { text: a.thresh ?? '' }), el('td', { class: 'mono', text: a.raw })])));
    openModal([
      el('div', { class: 'row' }, el('h3', { text: d.model }), el('span', { class: 'spacer' }), el('span', { class: 'pill ' + DISK_LEVEL[d.level][0], text: DISK_LEVEL[d.level][1] })),
      el('p', { class: 'muted small', text: `${diskSub(d)}${d.serial ? ' · S/N ' + d.serial : ''}${d.firmware ? ' · прошивка ' + d.firmware : ''}` }),
      el('div', { class: 'dh-table-wrap' }, el('table', { class: 'dh-table' }, el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))), el('tbody', {}, rows))),
      el('p', { class: 'muted small mt6', text: nvme ? 'Журнал здоровья NVMe. Красная точка — проблема, жёлтая — стоит присмотреться.' : '«Текущее» и «Худшее» — оценка диска (чем больше, тем лучше), «Порог» — ниже него атрибут считается отказавшим. Raw — исходное значение счётчика.' }),
      el('div', { class: 'row end mt' }, el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Закрыть')),
    ], 'wide xwide');
  }

  function renderDisks(disks) {
    const box = $('#hw-disks');
    const sum = $('#hw-disk-summary');
    if (!disks || disks.error) { sum.textContent = ''; box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted', text: disks && disks.error ? disks.error : 'Читаю SMART дисков…' }))); return; }
    if (!disks.length) { sum.textContent = ''; box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Данные о здоровье дисков доступны в Windows 10 и 11.' }))); return; }
    const kinds = {};
    for (const d of disks) kinds[d.media || 'Диск'] = (kinds[d.media || 'Диск'] || 0) + 1;
    const worst = disks.some((d) => d.level === 'bad') ? 'bad' : disks.some((d) => d.level === 'warn') ? 'warn' : 'ok';
    sum.replaceChildren(
      ...Object.entries(kinds).map(([k, n]) => el('span', { class: 'chip', text: `${n} × ${k}` })),
      el('span', { class: 'chip', text: 'всего ' + fmtSize(disks.reduce((a, d) => a + (d.size || 0), 0)) }),
      el('span', { class: 'pill ' + DISK_LEVEL[worst][0] }, ic(DISK_LEVEL[worst][2], 13), worst === 'ok' ? 'Все диски в порядке' : worst === 'warn' ? 'Есть предупреждения' : 'Нужно внимание'));
    const noSmart = disks.every((d) => !d.smart);
    box.replaceChildren(...disks.map((d) => {
      const [tone, label, icon] = DISK_LEVEL[d.level] || DISK_LEVEL.ok;
      const tiles = [
        tile('temp', 'Температура', d.temp != null ? `${d.temp}°C` : '—', tempTone(d), d.tempMax ? `Максимум за всё время: ${d.tempMax}°C` : ''),
        tile('clock', 'Наработка', fmtHours(d.hours), '', d.hours != null ? `${fmtNum(d.hours)} часов работы` : ''),
        tile('power', 'Включений', d.powerCycles != null ? fmtNum(d.powerCycles) : '—'),
        tile('download', 'Записано', fmtTB(d.written) || '—', '', d.read != null ? `Прочитано: ${fmtTB(d.read)}` : ''),
      ];
      const issue = (v) => (v > 0 ? 'warn' : '');
      const kv = [
        d.kind === 'hdd' || d.reallocated != null ? ['Переназначенные сектора', d.reallocated, issue(d.reallocated)] : null,
        d.pending != null ? ['Нестабильные сектора', d.pending, issue(d.pending)] : null,
        d.uncorrectable != null ? ['Неисправимые сектора', d.uncorrectable, issue(d.uncorrectable)] : null,
        d.crcErrors != null ? ['Ошибки кабеля (CRC)', d.crcErrors, issue(d.crcErrors)] : null,
        d.mediaErrors != null ? ['Ошибки носителя', d.mediaErrors, issue(d.mediaErrors)] : null,
        d.spare != null ? ['Свободный резерв', `${d.spare}%`] : null,
        d.unsafeShutdowns != null ? ['Внезапные отключения', fmtNum(d.unsafeShutdowns)] : null,
        d.read != null ? ['Прочитано всего', fmtTB(d.read)] : null,
        d.family ? ['Семейство', d.family] : null,
        d.formFactor ? ['Форм-фактор', d.formFactor.replace('inches', 'дюйма')] : null,
        d.firmware ? ['Прошивка', d.firmware] : null,
        d.serial ? ['Серийный номер', d.serial] : null,
        d.trim != null ? ['TRIM', d.trim ? 'поддерживается' : 'нет'] : null,
        d.readErrors != null && !d.smart ? ['Ошибки чтения/записи', (d.readErrors || 0) + (d.writeErrors || 0)] : null,
      ].filter((x) => x && x[1] != null && x[1] !== '');
      const parts = d.parts.length ? el('div', { class: 'dh-parts' }, d.parts.map((p) => {
        const used = p.size && p.free != null ? Math.round(((p.size - p.free) / p.size) * 100) : null;
        const fill = el('i');
        fill.style.width = (used || 0) + '%';
        return el('div', { class: 'dh-part' },
          el('div', { class: 'dh-part-top' }, el('b', { text: p.letter }), el('span', { class: 'muted', text: p.label || '' }), el('span', { class: 'spacer' }),
            el('span', { class: 'muted small', text: p.free != null ? `${fmtBytes(p.free)} свободно из ${fmtBytes(p.size)}` : fmtBytes(p.size) })),
          el('div', { class: 'bar ' + (used >= 90 ? 'hot' : used >= 75 ? 'mid' : '') }, fill));
      })) : null;
      const lifeBar = d.life != null ? gauge(`Ресурс SSD · износ ${100 - d.life}%`, d.life, 100, `осталось ${d.life}%`, d.life <= 30 ? 'hot' : '') : null;
      return el('div', { class: 'card disk-card ' + tone },
        el('div', { class: 'gpu-head' }, el('div', { class: 'disk-ic ' + tone }, ic(KIND_IC[d.kind] || 'disk', 24)),
          el('div', { class: 'spacer dh-title' }, el('h3', { text: d.model, title: d.model }), el('p', { class: 'muted small', text: diskSub(d) })),
          el('span', { class: 'pill ' + tone }, ic(icon, 14), label)),
        el('div', { class: 'dh-hero' }, healthRing(d, tone), el('div', { class: 'dh-tiles' }, tiles)),
        lifeBar,
        d.forecast ? el('div', { class: 'dh-forecast', 'data-tip': d.forecast.basis ? `Расчёт ${d.forecast.basis}` : '' }, ic('clock', 15), el('span', {}, el('b', { text: d.forecast.text }), d.forecast.perDay ? el('small', { text: ` · ≈ ${fmtTB(d.forecast.perDay)} записи в день` }) : null)) : null,
        parts,
        kv.length ? el('div', { class: 'dh-kv' }, kv.map(([k, v, t]) => el('div', { class: 'kv' }, el('span', { text: k }), el('b', { class: 'plain ' + (t || ''), text: String(v), title: String(v) })))) : null,
        d.reasons.length ? el('div', { class: 'disk-reasons' }, d.reasons.map((r) => el('div', {}, ic('alert', 14), el('span', { text: r })))) : null,
        d.notes && d.notes.length ? el('div', { class: 'disk-notes' }, d.notes.map((r) => el('div', {}, ic('info', 14), el('span', { text: r })))) : null,
        d.attrs.length ? el('button', { class: 'btn ghost dh-attrs', 'data-tip': 'Полная таблица SMART, как в CrystalDiskInfo', onclick: () => smartTable(d) }, ic('list', 15), `Все атрибуты SMART (${d.attrs.length})`) : null);
    }), ...(noSmart ? [el('div', { class: 'card muted small', text: 'Подробные данные SMART недоступны: программе нужны права администратора (запустите её через ярлык — права выдаются автоматически). Сейчас показаны сведения Windows.' })] : []));
  }

  let hwBusy = false;
  async function hardware(force = false) {
    if (hwBusy) return;
    hwBusy = true;
    try {
      if (force) renderDisks(null);
      const g = api('hw-info', { only: 'gpu' }).then((r) => renderGpu(r.gpu)).catch(() => {});
      const r = await api('hw-info', { force, only: 'disks' });
      renderDisks(r.disks);
      await g;
    } catch (e) { toast(e.message, 'err'); } finally { hwBusy = false; }
  }
  async function gpuOnly() {
    if (hwBusy) return;
    try { const r = await api('hw-info', { only: 'gpu' }); renderGpu(r.gpu); } catch (e) { /* ignore */ }
  }

  // ---------------- сеть ----------------
  const clock = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function minutes(sec) { const m = Math.round(sec / 60); return m < 1 ? 'меньше минуты' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`; }

  function renderSpeed(r, progress) {
    const box = $('#speed-box');
    const cell = (label, value, unit, icon) => el('div', { class: 'speed-cell' }, ic(icon, 18), el('div', { class: 'speed-num', text: value }), el('div', { class: 'speed-lbl', text: `${label}${unit ? ', ' + unit : ''}` }));
    if (progress) {
      const stage = { ping: 'Измеряю задержку…', down: 'Скачивание…', up: 'Загрузка…' }[progress.stage] || 'Замер…';
      box.replaceChildren(el('div', { class: 'wait-hero' }, el('div', { class: 'spinner' }), el('b', { text: stage })),
        el('div', { class: 'speed-row' }, cell('Задержка', progress.ping != null ? String(progress.ping) : '…', 'мс', 'activity'),
          cell('Скачивание', progress.down != null ? String(progress.down) : '…', 'Мбит/с', 'download'), cell('Загрузка', '…', 'Мбит/с', 'upload')));
      return;
    }
    if (!r) { box.replaceChildren(el('p', { class: 'muted', text: 'Замеров ещё не было.' })); return; }
    box.replaceChildren(el('div', { class: 'speed-row' }, cell('Скачивание', String(r.down), 'Мбит/с', 'download'), cell('Загрузка', String(r.up), 'Мбит/с', 'upload'), cell('Задержка', String(r.ping), 'мс', 'activity')),
      el('p', { class: 'muted small mt6', text: 'Замер: ' + clock(r.ts) }));
  }

  function renderNet(st) {
    const state = $('#net-state');
    const on = st.online;
    state.replaceChildren(el('div', { class: 'net-big ' + (on === false ? 'off' : on ? 'on' : '') },
      el('span', { class: 'dot ' + (on === false ? 'off' : on ? 'on' : '') }),
      el('b', { text: on === false ? 'Нет связи' : on ? 'Интернет работает' : 'Проверяю…' }),
      st.latency && on ? el('span', { class: 'muted', text: `отклик ${st.latency} мс` }) : null));
    $('#net-outages').replaceChildren(...(st.outages.length ? st.outages.slice(0, 8).map((o) => el('div', { class: 'item' },
      el('div', { class: 'item-ic' }, ic('alert', 16)), el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: clock(o.start) + (o.fixed ? ' · адаптер перезапущен' : '') }),
        el('div', { class: 'item-sub', text: `без связи ${minutes((o.end || Date.now() / 1000) - o.start)}${o.title ? ' · ' + o.title : ''}` })))) : [el('p', { class: 'muted', text: 'Обрывов не было 👍' })]));
    if (!speedRunning) renderSpeed(st.lastSpeed);
    renderDevices(st.devices);
  }

  function renderDevices(list) {
    const box = $('#dev-list');
    if (!list || !list.length) { box.replaceChildren(el('p', { class: 'muted', text: 'Нажмите «Найти устройства».' })); return; }
    const weekAgo = Date.now() / 1000 - 7 * 86400;
    box.replaceChildren(...list.map((d) => {
      const name = d.label || d.name || (/телефон/.test(d.vendor) ? 'Телефон или планшет' : d.vendor) || 'Неизвестное устройство';
      const icon = /этот компьютер/.test(d.vendor) ? 'monitor' : /телефон/.test(d.vendor) ? 'phone' : 'wifi';
      const title = el('button', { class: 'link-btn item-title', text: name, 'data-tip': 'Нажмите, чтобы подписать устройство (например, «Телевизор»)' });
      title.addEventListener('click', async () => {
        const v = await promptModal('Название устройства', name);
        if (v === null) return;
        await api('net-label', { mac: d.mac, label: v });
        network();
      });
      return el('div', { class: 'item' }, el('div', { class: 'item-ic' }, ic(icon, 17)),
        el('div', { class: 'item-main' }, el('div', { class: 'row gap6' }, title, d.first_seen > weekAgo ? el('span', { class: 'pill warn sm', text: 'новое' }) : null),
          el('div', { class: 'item-sub' }, secret(d.ip, 'ip'), ' · ', secret(d.mac, 'mac'), d.vendor ? ` · ${d.vendor}` : '')),
        el('span', { class: 'dot ' + (d.online ? 'on' : ''), 'data-tip': d.online ? 'В сети сейчас' : 'Сейчас не в сети' }));
    }));
  }

  let speedRunning = false;
  async function network() {
    try { const st = await api('net-status'); renderNet(st); renderDiag(st.diag, st); } catch (e) { /* ignore */ }
  }

  // ---------------- диагностика обрывов ----------------
  const DIAG_LOOK = { ok: ['ok', 'check'], isp: ['warn', 'globe'], dns: ['warn', 'globe'], gateway: ['err', 'alert'], link: ['err', 'alert'], dhcp: ['err', 'alert'], nogw: ['err', 'alert'], noadapter: ['err', 'alert'] };
  let lastNet = null;
  function renderDiag(d, st = lastNet) {
    lastNet = st;
    const box = $('#netdiag');
    if (!d) { box.replaceChildren(el('p', { class: 'muted', text: 'Обрывов пока не было. Нажмите «Проверить сейчас», чтобы посмотреть состояние сети.' })); return; }
    const [tone, icon] = DIAG_LOOK[d.cause] || DIAG_LOOK.ok;
    const x = d.details || {};
    const chips = [
      x.desc ? ['Адаптер', x.desc] : null,
      x.linkSpeed ? ['Скорость линка', x.linkSpeed] : null,
      x.wifi && x.wifi.signal != null ? ['Сигнал Wi-Fi', x.wifi.signal + '%'] : null,
      x.gw ? ['Роутер', `${x.gw} — ${x.pingGw ? 'отвечает' : 'не отвечает'}`] : null,
      ['Интернет', x.ping1 || x.ping8 ? 'есть' : 'нет'], ['DNS', x.dnsOk ? 'работает' : 'не отвечает'],
      x.driverDate ? ['Драйвер', `${x.driverVersion || ''} от ${new Date(Date.parse(x.driverDate)).toLocaleDateString('ru-RU')}`] : null,
      d.eventsTotal ? ['Сбросы адаптера за сутки', String(d.eventsTotal)] : null,
    ].filter(Boolean);
    const fix = async (action, label, confirmText) => {
      if (confirmText && !(await confirmModal(label + '?', confirmText, label, false))) return;
      try { await api('net-fix', { action }); toast('Готово'); } catch (e) { toast(e.message, 'err'); }
      network();
    };
    const auto = el('input', { type: 'checkbox' });
    auto.checked = !!(st && st.autoFix);
    auto.addEventListener('change', () => fix(auto.checked ? 'autofix_on' : 'autofix_off'));
    const btns = [
      el('button', { class: 'btn', 'data-tip': 'Выключить и снова включить сетевой адаптер — то же, что делает «Диагностика неполадок» Windows', onclick: () => fix('restart', 'Перезапустить адаптер', 'Связь пропадёт на 5–15 секунд.') }, ic('restart', 16), 'Перезапустить адаптер'),
      d.fixes.includes('energy') && !(st && st.energyBackup) ? el('button', { class: 'btn primary', 'data-tip': 'Запретить Windows отключать адаптер и выключить «зелёный» режим Ethernet (EEE). Прежние значения сохраняются — их можно вернуть', onclick: () => fix('energy', 'Отключить энергосбережение адаптера', `Будет выключено: ${d.energy.join('; ')}. Адаптер перезапустится (связь пропадёт на 5–15 секунд). Вернуть можно кнопкой здесь же.`) }, ic('zap', 16), 'Отключить энергосбережение') : null,
      st && st.energyBackup ? el('button', { class: 'btn ghost', 'data-tip': 'Вернуть настройки энергосбережения адаптера, которые были до изменения', onclick: () => fix('energy_restore', 'Вернуть энергосбережение', 'Настройки адаптера вернутся к прежним.') }, 'Вернуть энергосбережение') : null,
      d.fixes.includes('dns') ? el('button', { class: 'btn primary', onclick: () => fix('dns', 'Переключить DNS на 1.1.1.1 и 8.8.8.8', 'Вернуть автоматический DNS можно в любой момент.') }, ic('globe', 16), 'DNS 1.1.1.1 и 8.8.8.8') : null,
    ].filter(Boolean);
    box.replaceChildren(
      el('div', { class: 'nd-hero ' + tone }, el('div', { class: 'nd-ic' }, ic(icon, 22)),
        el('div', { class: 'spacer' }, el('b', { text: d.title }), el('p', { text: d.text }), el('span', { class: 'muted small', text: `Проверено ${new Date(d.ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` }))),
      d.advice.length ? el('div', { class: 'nd-advice' }, el('div', { class: 'cr-advice-h' }, ic('sparkles', 14), 'Как исправить'), d.advice.map((a) => el('div', { class: 'nd-adv-row' }, ic('check', 14), el('span', { text: a })))) : null,
      el('div', { class: 'nd-chips' }, chips.map(([k, v]) => el('div', { class: 'nd-chip' }, el('span', { text: k }), el('b', { text: v })))),
      el('div', { class: 'row wrap mt' }, ...btns),
      el('div', { class: 'set-row mt6' }, el('span', { class: 'set-ic' }, ic('restart', 17)), el('span', { class: 'set-text' }, el('b', { text: 'Сам перезапускать адаптер при обрыве' }), el('small', { text: 'Если роутер перестал отвечать — программа перезапустит сетевой адаптер, связь вернётся за 10–20 секунд' })), el('label', { class: 'switch' }, auto, el('span'))));
  }

  // ---------------- автозагрузка ----------------
  async function loadStartup() {
    $('#startup-count').textContent = 'Читаю автозагрузку…';
    let r;
    try { r = await api('startup-list'); } catch (e) { $('#startup-count').textContent = e.message; return; }
    if (!r.available) { $('#startup-count').textContent = 'Управление автозагрузкой доступно в Windows'; return; }
    const on = r.items.filter((x) => x.enabled).length;
    $('#startup-count').textContent = `Включено: ${on} из ${r.items.length}`;
    $('#startup-list').replaceChildren(...r.items.map((x) => {
      const sw = el('input', { type: 'checkbox' });
      sw.checked = x.enabled;
      sw.disabled = x.self;
      sw.addEventListener('change', async () => {
        try {
          await api('startup-set', { id: x.id, enabled: sw.checked });
          toast(`${x.name}: ${sw.checked ? 'будет запускаться вместе с Windows' : 'больше не запускается вместе с Windows'}`);
          loadStartup();
        } catch (e) { sw.checked = !sw.checked; toast(e.message, 'err'); }
      });
      return el('div', { class: 'item' + (x.enabled ? '' : ' dim-item') }, el('div', { class: 'item-ic' }, ic(x.kind === 'task' ? 'calendar' : x.kind === 'folder' ? 'folder' : 'rocket', 17)),
        el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: x.name }),
          el('div', { class: 'item-sub', text: [x.publisher, x.source].filter(Boolean).join(' · '), title: x.command })),
        el('label', { class: 'switch', 'data-tip': x.self ? 'Автозапуск PC Full Control меняется в «Настройках»' : x.enabled ? 'Выключить запуск вместе с Windows (можно вернуть)' : 'Включить запуск вместе с Windows' }, sw, el('span')));
    }));
  }

  // ---------------- кнопки ----------------
  $('#hw-refresh').addEventListener('click', () => hardware(true));
  $('#speed-run').addEventListener('click', async () => {
    const b = $('#speed-run');
    b.disabled = true;
    speedRunning = true;
    renderSpeed(null, { stage: 'ping' });
    try {
      const r = await api('net-speedtest');
      speedRunning = false;
      renderSpeed(r);
      toast(`Скорость: ↓ ${r.down} / ↑ ${r.up} Мбит/с`);
    } catch (e) { speedRunning = false; toast(e.message, 'err'); network(); } finally { b.disabled = false; }
  });
  window.pcc.on('net-progress', (p) => { if (speedRunning) renderSpeed(null, p); });
  $('#netdiag-run').addEventListener('click', async () => {
    const b = $('#netdiag-run');
    b.disabled = true;
    b.replaceChildren(ic('hourglass', 15), 'Проверяю…');
    try { renderDiag(await api('netdiag-run')); network(); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; b.replaceChildren(ic('search', 15), 'Проверить сейчас'); }
  });
  window.pcc.on('netdiag', (d) => renderDiag(d));
  $('#dev-scan').addEventListener('click', async () => {
    const b = $('#dev-scan');
    b.disabled = true;
    b.replaceChildren(ic('hourglass', 15), 'Ищу…');
    try { renderDevices(await api('net-scan')); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; b.replaceChildren(ic('search', 15), 'Найти устройства'); }
  });
  $('#startup-refresh').addEventListener('click', loadStartup);
  $('#weekly-preview').addEventListener('click', async () => {
    try {
      const text = await api('weekly-preview');
      const send = await openModal([el('h3', { text: 'Отчёт за неделю' }),
        el('pre', { class: 'output report-pre', text: text.replace(/<[^>]+>/g, '') }),
        el('div', { class: 'row end mt' }, el('button', { class: 'btn', onclick: () => closeModal(false) }, 'Закрыть'),
          el('button', { class: 'btn primary', onclick: () => closeModal(true), 'data-tip': 'Отправить этот отчёт в Telegram сейчас' }, ic('telegram', 16), 'Отправить в Telegram'))], 'wide');
      if (send) { await api('weekly-send'); toast('Отчёт отправлен в Telegram'); }
    } catch (e) { toast(e.message, 'err'); }
  });
  api('extras-state').then((s) => { if (s && s.hasCamera === false) $('#cam-note').textContent = 'Веб-камера не найдена — функция включится сама, когда камера появится'; }).catch(() => {});

  return { hardware, gpuOnly, network, loadStartup };
})();
