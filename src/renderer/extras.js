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

  function renderDisks(disks) {
    const box = $('#hw-disks');
    if (!disks || disks.error) { box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted', text: disks && disks.error ? disks.error : 'Загрузка…' }))); return; }
    if (!disks.length) { box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Данные о здоровье дисков доступны в Windows 10 и 11.' }))); return; }
    box.replaceChildren(...disks.map((d) => {
      const [tone, label, icon] = LEVEL[d.level] || LEVEL.ok;
      const rows = [
        ['Тип', [d.media, d.bus].filter(Boolean).join(' · ') || '—'],
        ['Объём', fmtBytes(d.size)],
        ['Температура', d.temp != null ? `${d.temp}°C${d.tempMax ? ` (макс. ${d.tempMax}°C)` : ''}` : null],
        ['Наработка', d.hours != null ? `${Math.round(d.hours).toLocaleString('ru-RU')} ч (${Math.round(d.hours / 24)} дн.)` : null],
        ['Ошибки чтения/записи', d.readErrors != null || d.writeErrors != null ? String((d.readErrors || 0) + (d.writeErrors || 0)) : null],
        ['Состояние Windows', d.health || null],
      ].filter((x) => x[1]);
      return el('div', { class: 'card disk-card ' + tone },
        el('div', { class: 'gpu-head' }, el('div', { class: 'disk-ic ' + tone }, ic('disk', 22)),
          el('div', { class: 'spacer' }, el('h3', { text: d.model }), el('p', { class: 'muted small', text: d.volumes ? 'Разделы: ' + d.volumes : '' })),
          el('span', { class: 'pill ' + tone }, ic(icon, 14), label)),
        d.wear != null ? gauge('Износ SSD', d.wear, 100, `${d.wear}%`, d.wear >= 70 ? 'hot' : '') : null,
        el('div', {}, rows.map(([k, v]) => el('div', { class: 'kv' }, el('span', { text: k }), el('b', { text: v })))),
        d.reasons.length ? el('div', { class: 'disk-reasons' }, d.reasons.map((r) => el('div', {}, ic('alert', 14), el('span', { text: r })))) : null);
    }));
  }

  let hwBusy = false;
  async function hardware(force = false) {
    if (hwBusy) return;
    hwBusy = true;
    try {
      const r = await api('hw-info', { force });
      renderGpu(r.gpu);
      renderDisks(r.disks);
    } catch (e) { toast(e.message, 'err'); } finally { hwBusy = false; }
  }
  async function gpuOnly() {
    if (hwBusy) return;
    try { const r = await api('hw-info', {}); renderGpu(r.gpu); } catch (e) { /* ignore */ }
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
      el('div', { class: 'item-ic' }, ic('alert', 16)), el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: clock(o.start) }),
        el('div', { class: 'item-sub', text: `без связи ${minutes((o.end || Date.now() / 1000) - o.start)}` })))) : [el('p', { class: 'muted', text: 'Обрывов не было 👍' })]));
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
    try { renderNet(await api('net-status')); } catch (e) { /* ignore */ }
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
