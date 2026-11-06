'use strict';
// «Ещё» на телефоне: Железо (видеокарта, FPS, диски), Сеть (интернет, скорость, устройства, доступ из интернета), Автозагрузка.
const MExtras = (() => {
  let gpuTimer = null;
  const LEVEL = { ok: ['ok', 'Исправен'], warn: ['warn', 'Предупреждения'], bad: ['err', 'Требует внимания'] };
  const clock = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function meter(label, value, max, text, hot = false) {
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, ((value || 0) / (max || 1)) * 100)) + '%';
    return el('div', { class: 'm-meter' + (hot ? ' hot' : '') }, el('div', { class: 'm-meter-top' }, el('span', { text: label }), el('b', { text })), el('div', { class: 'bar' }, fill));
  }

  // ---------------- железо ----------------
  function renderGpu(r) {
    const box = $('#m-gpu');
    if (!r || !r.gpus || !r.gpus.length) { box.replaceChildren(el('div', { class: 'card muted', text: 'Видеокарта не найдена или не отдаёт данные.' })); return; }
    box.replaceChildren(...r.gpus.map((g, i) => {
      const hot = g.temp != null && g.temp >= 80;
      const fps = i === 0 ? r.fps : null;
      return el('div', { class: 'card' },
        el('div', { class: 'm-gpu-head' }, el('div', { class: 'item-ic' }, ic('gpu', 20)), el('div', { class: 'item-main' }, el('div', { class: 'item-title wrap', text: g.name })),
          g.temp != null ? el('div', { class: 'm-gpu-temp' + (hot ? ' hot' : ''), text: `${Math.round(g.temp)}°` }) : null),
        i === 0 ? el('div', { class: 'm-fps' + (fps ? '' : ' idle') }, el('div', { class: 'm-fps-num', text: fps ? String(fps.fps) : '—' }),
          el('div', { class: 'm-fps-lbl', text: fps ? `кадр/с · ${fps.app.replace(/\.exe$/i, '')} · 1% низких ${fps.low1}` : r.fpsAvailable ? 'кадр/с — запустите игру' : 'счётчик кадров недоступен' })) : null,
        meter('Загрузка', g.util, 100, g.util != null ? Math.round(g.util) + '%' : '—', g.util >= 90),
        g.memTotal ? meter('Видеопамять', g.memUsed, g.memTotal, `${fmtBytes(g.memUsed || 0)} / ${fmtBytes(g.memTotal)}`) : null,
        el('div', { class: 'm-kv' }, [
          g.clock != null ? ['Частота', `${Math.round(g.clock)} МГц`] : null,
          g.power != null ? ['Мощность', `${Math.round(g.power)} Вт`] : null,
          g.fan != null ? ['Вентилятор', `${Math.round(g.fan)}%`] : null,
        ].filter(Boolean).map(([k, v]) => el('div', { class: 'about-row' }, el('span', { text: k }), el('b', { text: v })))));
    }));
  }

  // ---------------- диски (как в CrystalDiskInfo) ----------------
  const DISK_LEVEL = { ok: ['ok', 'Хорошо'], warn: ['warn', 'Тревога'], bad: ['err', 'Плохо'] };
  const KIND_IC = { hdd: 'hdd', ssd: 'ssd', nvme: 'nvme' };
  const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU');
  function fmtHours(h) {
    if (h == null) return '—';
    const d = Math.floor(h / 24);
    if (d >= 365) { const y = Math.floor(d / 365); const m = Math.floor((d % 365) / 30.4); return `${y} г.${m ? ` ${m} мес.` : ''}`; }
    return d >= 1 ? `${d} дн.` : `${Math.round(h)} ч`;
  }
  const fmtTB = (b) => (b == null ? '—' : b >= 1e12 ? `${(b / 1e12).toFixed(2)} ТБ` : `${(b / 1e9).toFixed(1)} ГБ`);
  const fmtSize = (b) => (!b ? '' : b >= 1e12 ? `${(b / 1e12).toFixed(b >= 1e13 ? 0 : 1)} ТБ` : `${Math.round(b / 1e9)} ГБ`);

  function smartSheet(d) {
    const nvme = d.attrs.length && d.attrs[0].value === undefined;
    openSheet('SMART: ' + d.model, [
      el('p', { class: 'muted small', text: nvme ? 'Журнал здоровья NVMe.' : 'Текущее / худшее / порог — оценка диска (больше — лучше). Raw — исходное значение.' }),
      el('div', { class: 'm-smart' }, d.attrs.map((a) => el('div', { class: 'm-smart-row ' + a.status },
        el('span', { class: 'm-smart-dot ' + a.status }),
        el('div', { class: 'm-smart-main' }, el('b', { text: `${a.id} · ${a.name}` }),
          nvme ? null : el('small', { text: `текущее ${a.value ?? '—'} · худшее ${a.worst ?? '—'} · порог ${a.thresh ?? '—'}` })),
        el('code', { text: a.raw })))),
    ]);
  }

  function renderDisks(disks) {
    const box = $('#m-disks');
    if (!disks) { box.replaceChildren(el('div', { class: 'card muted', text: 'Читаю SMART дисков…' })); return; }
    if (disks.error || !disks.length) { box.replaceChildren(el('div', { class: 'card muted', text: disks.error ? disks.error : 'Данные о дисках доступны в Windows 10 и 11.' })); return; }
    box.replaceChildren(...disks.map((d) => {
      const [tone, label] = DISK_LEVEL[d.level] || DISK_LEVEL.ok;
      const ring = el('div', { class: 'm-dh-ring ' + tone + (d.life != null ? '' : ' word') }, el('div', {}, el('b', { text: d.life != null ? `${d.life}%` : label }), el('span', { text: d.life != null ? label : 'состояние' })));
      ring.style.setProperty('--p', d.life != null ? d.life : 100);
      const hot = d.temp != null && d.temp >= ({ hdd: 55, nvme: 80 }[d.kind] || 70);
      const tiles = el('div', { class: 'm-dh-tiles' },
        [['Температура', d.temp != null ? `${d.temp}°C` : '—', hot ? 'hot' : ''], ['Наработка', fmtHours(d.hours)],
          ['Включений', d.powerCycles != null ? fmtNum(d.powerCycles) : '—'], ['Записано', fmtTB(d.written)]]
          .map(([k, v, t]) => el('div', { class: 'm-dh-tile ' + (t || '') }, el('span', { text: k }), el('b', { text: v }))));
      const kv = [
        d.reallocated != null ? ['Переназначенные сектора', d.reallocated] : null,
        d.pending != null ? ['Нестабильные сектора', d.pending] : null,
        d.uncorrectable != null ? ['Неисправимые сектора', d.uncorrectable] : null,
        d.mediaErrors != null ? ['Ошибки носителя', d.mediaErrors] : null,
        d.spare != null ? ['Свободный резерв', d.spare + '%'] : null,
        d.unsafeShutdowns != null ? ['Внезапные отключения', fmtNum(d.unsafeShutdowns)] : null,
        d.read != null ? ['Прочитано всего', fmtTB(d.read)] : null,
        d.firmware ? ['Прошивка', d.firmware] : null,
      ].filter(Boolean);
      return el('div', { class: 'card m-disk ' + tone },
        el('div', { class: 'm-gpu-head' }, el('div', { class: 'item-ic disk-' + tone }, ic(KIND_IC[d.kind] || 'disk', 20)),
          el('div', { class: 'item-main' }, el('div', { class: 'item-title wrap', text: d.model }),
            el('div', { class: 'item-sub', text: [d.kindText, d.rpm ? `${fmtNum(d.rpm)} об/мин` : null, fmtSize(d.size)].filter(Boolean).join(' · ') })),
          el('span', { class: 'pill ' + tone, text: label })),
        el('div', { class: 'm-dh-hero' }, ring, tiles),
        d.life != null ? meter(`Ресурс SSD · износ ${100 - d.life}%`, d.life, 100, `осталось ${d.life}%`, d.life <= 30) : null,
        d.forecast ? el('div', { class: 'm-forecast' }, ic('clock', 16), el('span', { text: d.forecast.text })) : null,
        d.parts.length ? el('div', { class: 'm-dh-parts' }, d.parts.map((p) => meter(`${p.letter} ${p.label || ''}`, p.size - (p.free || 0), p.size || 1,
          p.free != null ? `${fmtBytes(p.free)} свободно из ${fmtBytes(p.size)}` : fmtBytes(p.size), p.free != null && p.free / p.size < 0.1))) : null,
        kv.length ? el('div', { class: 'm-kv' }, kv.map(([k, v]) => el('div', { class: 'about-row' }, el('span', { text: k }), el('b', { class: Number(v) > 0 && /сектора|носителя/.test(k) ? 'warn-text' : '', text: String(v) })))) : null,
        d.reasons.length ? el('div', { class: 'm-reasons' }, d.reasons.map((r) => el('div', { text: '• ' + r }))) : null,
        d.notes && d.notes.length ? el('div', { class: 'm-notes' }, d.notes.map((r) => el('div', { text: 'ℹ️ ' + r }))) : null,
        d.attrs.length ? el('button', { class: 'btn m-dh-attrs', onclick: () => smartSheet(d) }, ic('list', 18), `Все атрибуты SMART (${d.attrs.length})`) : null);
    }));
  }

  async function hardware() {
    $('#m-gpu').replaceChildren(el('div', { class: 'card muted', text: 'Загрузка…' }));
    try {
      const r = await api('/api/hw?only=gpu');
      renderGpu(r.gpu);
    } catch (e) { toast(e.message, 'err'); }
    if (!$('#m-disks').children.length) renderDisks(null);
    api('/api/hw?only=disks').then((r) => renderDisks(r.disks)).catch((e) => toast(e.message, 'err'));
    clearInterval(gpuTimer);
    gpuTimer = setInterval(async () => {
      if (morePane !== 'hardware' || tab !== 'more' || document.hidden) { if (morePane !== 'hardware') clearInterval(gpuTimer); return; }
      try { renderGpu((await api('/api/hw?only=gpu')).gpu); } catch (e) { /* ignore */ }
    }, 3000);
  }

  // ---------------- сеть ----------------
  function renderSpeed(r, busy = false) {
    const cell = (v, l) => el('div', { class: 'm-speed-cell' }, el('b', { text: v }), el('span', { text: l }));
    $('#m-speed').replaceChildren(busy ? el('div', { class: 'm-wait' }, el('div', { class: 'spinner' }), el('span', { class: 'muted', text: 'Замеряю… ≈20 секунд' }))
      : r ? el('div', {}, el('div', { class: 'm-speed-row' }, cell(String(r.down), '↓ Мбит/с'), cell(String(r.up), '↑ Мбит/с'), cell(String(r.ping), 'мс')),
        el('p', { class: 'muted small', text: 'Замер: ' + clock(r.ts) }))
        : el('p', { class: 'muted', text: 'Замеров ещё не было.' }));
  }

  function renderDevices(list) {
    const box = $('#m-devices');
    if (!list || !list.length) { box.replaceChildren(el('p', { class: 'muted small', text: 'Нажмите «Найти устройства».' })); return; }
    const weekAgo = Date.now() / 1000 - 7 * 86400;
    box.replaceChildren(...list.map((d) => {
      const name = d.label || d.name || (/телефон/.test(d.vendor) ? 'Телефон или планшет' : d.vendor) || 'Неизвестное устройство';
      const row = el('button', { class: 'item tap app-row-m', 'data-tip': 'Нажмите, чтобы подписать устройство' },
        el('div', { class: 'item-ic' }, ic(/этот компьютер/.test(d.vendor) ? 'monitor' : /телефон/.test(d.vendor) ? 'phone' : 'wifi', 18)),
        el('div', { class: 'item-main' }, el('div', { class: 'item-title' }, name, d.first_seen > weekAgo ? el('span', { class: 'pill warn tiny', text: 'новое' }) : null),
          el('div', { class: 'item-sub' }, secret(d.ip, 'ip'), d.vendor && d.vendor !== name ? ' · ' + d.vendor : '')),
        el('span', { class: 'dot ' + (d.online ? 'on' : '') }));
      row.addEventListener('click', async () => {
        const input = el('input', { class: 'input', value: d.label || '', placeholder: 'Например: Телевизор' });
        const v = await openSheet('Название устройства', [input, el('div', { class: 'sheet-options' },
          el('button', { class: 'btn primary', onclick: () => closeSheet(input.value.trim()) }, 'Сохранить'), el('button', { class: 'btn', onclick: () => closeSheet(null) }, 'Отмена'))]);
        if (v === null || v === undefined) return;
        await api('/api/net/label', { json: { mac: d.mac, label: v } }).catch((e) => toast(e.message, 'err'));
        network();
      });
      return row;
    }));
  }

  async function network() {
    let st;
    try { st = await api('/api/net'); } catch (e) { toast(e.message, 'err'); return; }
    const on = st.online;
    $('#m-net-state').replaceChildren(el('div', { class: 'card-title' }, ic('globe', 18), 'Интернет'),
      el('div', { class: 'm-net-big ' + (on === false ? 'off' : on ? 'on' : '') }, el('span', { class: 'dot ' + (on === false ? 'off' : on ? 'on' : '') }),
        el('b', { text: on === false ? 'Нет связи' : on ? 'Работает' : 'Проверяю…' }), st.latency && on ? el('span', { class: 'muted', text: ` · ${st.latency} мс` }) : null),
      el('p', { class: 'muted small', text: st.outages.length ? `Обрывов за неделю: ${st.outages.length}. Последний: ${clock(st.outages[0].start)}, ${Math.max(1, Math.round((st.outages[0].end - st.outages[0].start) / 60))} мин` : 'Обрывов за неделю не было 👍' }));
    if (!st.speedBusy) renderSpeed(st.lastSpeed); else renderSpeed(null, true);
    renderDevices(st.devices);
  }

  $('#m-speed-run').addEventListener('click', async () => {
    const b = $('#m-speed-run');
    b.disabled = true;
    renderSpeed(null, true);
    try { const r = await api('/api/net/speedtest', { json: {} }); renderSpeed(r); haptic(20); } catch (e) { toast(e.message, 'err'); network(); } finally { b.disabled = false; }
  });
  $('#m-dev-scan').addEventListener('click', async () => {
    const b = $('#m-dev-scan');
    b.disabled = true;
    b.classList.add('busy');
    try { renderDevices(await api('/api/net/scan', { json: {} })); } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; b.classList.remove('busy'); }
  });
  // ---------------- автозагрузка ----------------
  async function startup() {
    $('#m-startup-count').textContent = 'Читаю автозагрузку…';
    let r;
    try { r = await api('/api/startup'); } catch (e) { $('#m-startup-count').textContent = e.message; return; }
    if (!r.available) { $('#m-startup-count').textContent = 'Доступно только в Windows'; $('#m-startup').replaceChildren(); return; }
    $('#m-startup-count').textContent = `Включено ${r.items.filter((x) => x.enabled).length} из ${r.items.length}. Выключенные программы не удаляются — их можно вернуть.`;
    $('#m-startup').replaceChildren(...r.items.map((x) => {
      const sw = el('input', { type: 'checkbox' });
      sw.checked = x.enabled;
      sw.disabled = x.self;
      sw.addEventListener('change', async () => {
        try { await api('/api/startup/set', { json: { id: x.id, enabled: sw.checked } }); haptic(10); toast(`${x.name}: ${sw.checked ? 'включено' : 'выключено'}`); }
        catch (e) { sw.checked = !sw.checked; toast(e.message, 'err'); }
      });
      return el('label', { class: 'item' + (x.enabled ? '' : ' dim-item') }, el('div', { class: 'item-ic' }, ic(x.kind === 'task' ? 'calendar' : 'rocket', 18)),
        el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: x.name }), el('div', { class: 'item-sub', text: x.publisher || x.source })),
        el('span', { class: 'switch', 'data-tip': x.self ? 'Меняется в настройках программы на ПК' : 'Запускать вместе с Windows' }, sw, el('span')));
    }));
  }

  return { hardware, network, startup };
})();
