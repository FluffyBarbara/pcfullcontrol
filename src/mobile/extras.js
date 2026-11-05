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

  function renderDisks(disks) {
    const box = $('#m-disks');
    if (!disks || disks.error || !disks.length) { box.replaceChildren(el('div', { class: 'card muted', text: disks && disks.error ? disks.error : 'Данные о дисках доступны в Windows 10 и 11.' })); return; }
    box.replaceChildren(...disks.map((d) => {
      const [tone, label] = LEVEL[d.level] || LEVEL.ok;
      return el('div', { class: 'card' },
        el('div', { class: 'm-gpu-head' }, el('div', { class: 'item-ic disk-' + tone }, ic('disk', 20)),
          el('div', { class: 'item-main' }, el('div', { class: 'item-title wrap', text: d.model }), el('div', { class: 'item-sub', text: [d.volumes, d.media, fmtBytes(d.size)].filter(Boolean).join(' · ') })),
          el('span', { class: 'pill ' + tone, text: label })),
        d.wear != null ? meter('Износ SSD', d.wear, 100, d.wear + '%', d.wear >= 70) : null,
        el('div', { class: 'm-kv' }, [
          d.temp != null ? ['Температура', `${d.temp}°C`] : null,
          d.hours != null ? ['Наработка', `${Math.round(d.hours / 24)} дн.`] : null,
          (d.readErrors || d.writeErrors) ? ['Ошибки', String((d.readErrors || 0) + (d.writeErrors || 0))] : null,
        ].filter(Boolean).map(([k, v]) => el('div', { class: 'about-row' }, el('span', { text: k }), el('b', { text: v })))),
        d.reasons.length ? el('div', { class: 'm-reasons' }, d.reasons.map((r) => el('div', { text: '• ' + r }))) : null);
    }));
  }

  async function hardware() {
    $('#m-gpu').replaceChildren(el('div', { class: 'card muted', text: 'Загрузка…' }));
    try {
      const r = await api('/api/hw');
      renderGpu(r.gpu);
      renderDisks(r.disks);
    } catch (e) { toast(e.message, 'err'); }
    clearInterval(gpuTimer);
    gpuTimer = setInterval(async () => {
      if (morePane !== 'hardware' || tab !== 'more' || document.hidden) { if (morePane !== 'hardware') clearInterval(gpuTimer); return; }
      try { renderGpu((await api('/api/hw')).gpu); } catch (e) { /* ignore */ }
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
