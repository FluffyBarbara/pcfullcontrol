'use strict';
// Графики температур, игры, синие экраны, «Место на диске», оформление (тема/акцент), USB и тревожная кнопка.
const More = (() => {
  const fmtDay = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const dur = (s) => { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return h ? `${h} ч ${m} мин` : `${m} мин`; };
  const fmtSz = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} ТБ` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} МБ` : `${Math.max(1, Math.round(b / 1e3))} КБ`);

  // ---------------- температуры ----------------
  let tempHours = 24;
  let tempData = null;
  const LINE_COLORS = ['#f97316', '#10b981', '#22d3ee', '#a855f7', '#f472b6', '#eab308', '#3b82f6'];

  async function temps() {
    try { tempData = await api('temps', { hours: tempHours }); } catch (e) { return; }
    drawTemps();
  }

  function seriesList() {
    if (!tempData) return [];
    const list = [];
    if (tempData.cpu.length) list.push({ name: 'Процессор', pts: tempData.cpu, stat: tempData.stats.cpu, limit: tempData.limits.cpu });
    if (tempData.gpu.length) list.push({ name: 'Видеокарта', pts: tempData.gpu, stat: tempData.stats.gpu, limit: tempData.limits.gpu });
    for (const [name, pts] of Object.entries(tempData.disks)) list.push({ name: name.replace(/\s+/g, ' '), pts, stat: tempData.stats.disks[name], limit: 60, disk: true });
    list.forEach((s, i) => { s.color = LINE_COLORS[i % LINE_COLORS.length]; });
    return list;
  }

  function drawTemps() {
    const c = $('#temps-chart');
    if (!c || !c.offsetParent) return;
    const list = seriesList();
    $('#temps-legend').replaceChildren(...list.map((s) => { const i = el('i'); i.style.background = s.color; return el('span', {}, i, s.name); }));
    $('#temps-stats').replaceChildren(...list.map((s) => el('div', { class: 'temps-stat' }, el('span', { class: 'muted', text: s.name }),
      el('b', { class: s.stat && s.stat.max >= s.limit ? 'hot' : '', text: s.stat ? `макс. ${s.stat.max}° · ср. ${s.stat.avg}°` : '—' }),
      s.stat ? el('span', { class: 'muted small', text: `пик ${fmtDay(s.stat.maxAt)}` }) : null)));
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth; const h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    const all = list.flatMap((s) => s.pts.map((p) => p[2]));
    if (!all.length) { g.fillStyle = v('--dim'); g.font = '13px "Segoe UI", sans-serif'; g.fillText('Данные собираются: температуры записываются каждые 30 секунд (диски — раз в 10 минут).', 16, h / 2); return; }
    const lo = Math.max(0, Math.floor((Math.min(...list.flatMap((s) => s.pts.map((p) => p[1]))) - 5) / 10) * 10);
    const hi = Math.max(lo + 30, Math.ceil((Math.max(...all) + 5) / 10) * 10);
    const L = 36; const T = 10; const B = 22; const R = 8;
    const t0 = tempData.since; const t1 = Date.now() / 1000;
    const x = (ts) => L + (w - L - R) * ((ts - t0) / (t1 - t0));
    const y = (val) => T + (h - T - B) * (1 - (val - lo) / (hi - lo));
    g.font = '11px "Segoe UI", sans-serif';
    g.fillStyle = v('--dim');
    g.strokeStyle = `rgba(${v('--ov')}, .06)`;
    for (let val = lo; val <= hi; val += 10) { g.beginPath(); g.moveTo(L, y(val)); g.lineTo(w - R, y(val)); g.stroke(); g.fillText(val + '°', 4, y(val) + 4); }
    for (let i = 0; i <= 5; i++) {
      const ts = t0 + ((t1 - t0) * i) / 5;
      const d = new Date(ts * 1000);
      const label = tempHours > 24 ? d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric' }) : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      g.fillText(label, Math.min(w - 44, Math.max(L, x(ts) - 16)), h - 4);
    }
    // Линия перегрева
    const hot = Math.min(...list.filter((s) => !s.disk).map((s) => s.limit), 999);
    if (hot > lo && hot < hi) {
      g.setLineDash([5, 5]); g.strokeStyle = 'rgba(255, 93, 108, .55)';
      g.beginPath(); g.moveTo(L, y(hot)); g.lineTo(w - R, y(hot)); g.stroke(); g.setLineDash([]);
      g.fillStyle = 'rgba(255, 93, 108, .8)'; g.fillText(`перегрев ${hot}°`, w - R - 80, y(hot) - 4);
    }
    for (const s of list) {
      g.beginPath();
      let prev = null;
      for (const p of s.pts) {
        const gap = prev && p[0] - prev[0] > Math.max(1800, (t1 - t0) / 40); // пауза (ПК был выключен) — разрыв линии
        if (!prev || gap) g.moveTo(x(p[0]), y(p[1])); else g.lineTo(x(p[0]), y(p[1]));
        prev = p;
      }
      g.strokeStyle = s.color; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
      // Пик
      if (s.stat) {
        const px = x(s.stat.maxAt); const py = y(s.stat.max);
        g.fillStyle = s.color; g.beginPath(); g.arc(px, py, 3.5, 0, Math.PI * 2); g.fill();
        if (s.stat.max >= s.limit) { g.fillStyle = '#ff5d6c'; g.fillText(`🔥 ${s.stat.max}°`, Math.min(w - 50, px + 6), py - 6); }
      }
    }
  }

  // ---------------- игры ----------------
  async function games() {
    let r;
    try { r = await api('games', { days: 7 }); } catch (e) { return; }
    $('#games-total').textContent = r.total ? `всего ${dur(r.total)}` : '';
    const box = $('#games-list');
    if (!r.games.length) {
      box.replaceChildren(el('p', { class: 'muted', text: 'За неделю игр не было. Время в играх и средний FPS записываются сами, пока игра открыта на экране.' }));
      return;
    }
    const top = r.games[0].seconds;
    box.replaceChildren(
      r.now ? el('div', { class: 'game-now' }, ic('play', 14), `Сейчас: ${r.now.title}${r.now.fps ? ` — ${r.now.fps} FPS` : ''}`) : '',
      ...r.games.slice(0, 8).map((g) => {
        const fill = el('i');
        fill.style.width = Math.max(3, (g.seconds / top) * 100) + '%';
        return el('div', { class: 'game-row' }, el('b', { text: g.title }), el('span', { class: 'muted small', text: `${dur(g.seconds)}${g.avgFps ? ` · ${g.avgFps} FPS` : ''}` }), el('div', { class: 'bar' }, fill));
      }));
  }

  // ---------------- синие экраны ----------------
  function ago(ts) {
    const d = Math.floor((Date.now() / 1000 - ts) / 86400);
    if (d < 1) return 'сегодня';
    if (d === 1) return 'вчера';
    if (d < 7) return `${d} дн. назад`;
    if (d < 31) { const w = Math.round(d / 7); return `${w} нед. назад`; }
    return `${Math.round(d / 30)} мес. назад`;
  }

  let crashAll = false;
  async function crashes() {
    const box = $('#crashes-list');
    const head = $('#crashes-badge');
    let list;
    try { list = await api('crashes'); } catch (e) { box.replaceChildren(el('p', { class: 'muted', text: e.message })); return; }
    const bsod = list.filter((c) => c.kind === 'bsod').length;
    head.className = 'pill ' + (!list.length ? 'ok' : bsod ? 'err' : 'warn');
    head.replaceChildren(ic(!list.length ? 'check' : 'alert', 13), !list.length ? 'Всё стабильно' : `${list.length} ${list.length === 1 ? 'сбой' : list.length < 5 ? 'сбоя' : 'сбоев'} за 90 дней`);
    if (!list.length) {
      box.replaceChildren(el('div', { class: 'cr-empty' }, el('div', { class: 'cr-empty-ic' }, ic('shield', 30)),
        el('div', {}, el('b', { text: 'Компьютер работает стабильно' }), el('p', { class: 'muted small', text: 'За 90 дней не было ни синих экранов, ни внезапных выключений.' }))));
      return;
    }
    const shown = crashAll ? list : list.slice(0, 3);
    box.replaceChildren(...shown.map((c) => {
      const bs = c.kind === 'bsod';
      return el('div', { class: 'cr-item ' + (bs ? 'bsod' : 'power') },
        el('div', { class: 'cr-ic' }, ic(bs ? 'crash' : 'zap', 20)),
        el('div', { class: 'cr-body' },
          el('div', { class: 'cr-top' }, el('b', { text: c.title }), el('span', { class: 'cr-when', 'data-tip': fmtDay(c.ts) }, ic('clock', 12), `${fmtDay(c.ts)} · ${ago(c.ts)}`)),
          c.code ? el('div', { class: 'cr-codes' }, el('code', { text: c.code }), c.name ? el('span', { class: 'cr-name', text: c.name }) : null) : null,
          el('p', { class: 'cr-text', text: c.text }),
          el('div', { class: 'cr-advice' }, el('div', { class: 'cr-advice-h' }, ic('sparkles', 14), 'Что делать'), el('p', { text: c.advice })),
          c.minidump ? el('div', { class: 'cr-dump', 'data-tip': 'Файл с подробностями сбоя — пригодится мастеру' }, ic('file', 13), c.minidump) : null));
    }), ...(list.length > 3 ? [el('button', { class: 'btn ghost sm cr-more', onclick: () => { crashAll = !crashAll; crashes(); } }, ic(crashAll ? 'chevronLeft' : 'chevronDown', 14), crashAll ? 'Свернуть' : `Показать все (${list.length})`)] : []));
  }

  function hardware() { temps(); games(); crashes(); }

  // ---------------- место на диске ----------------
  let spaceRoot = null;
  let spaceDir = null;
  const selected = new Map(); // путь → размер
  const COLORS = ['#6d7cff', '#22d3ee', '#a855f7', '#f472b6', '#fb923c', '#10b981', '#eab308', '#3b82f6', '#ef4444', '#14b8a6'];

  async function spaceShow() {
    let roots = [];
    try { roots = await api('space-roots'); } catch (e) { /* ignore */ }
    if (!spaceRoot && roots.length) spaceRoot = (roots.find((r) => /^C:/i.test(r.mount)) || roots[0]).mount;
    $('#space-roots').replaceChildren(...roots.map((r) => el('span', { class: 'chip' + (r.mount === spaceRoot ? ' active' : ''), 'data-tip': `Свободно ${fmtSz(r.free)} из ${fmtSz(r.total)}`, onclick: () => { spaceRoot = r.mount; spaceShow(); } }, `${r.mount} · ${fmtSz(r.free)} свободно`)));
    spaceView();
  }

  function onSpace(st) { renderProgress(st); if (st.state === 'done') spaceView(); }

  function renderProgress(st) {
    const box = $('#space-progress');
    if (!st || st.state !== 'scanning') { box.classList.add('hidden'); $('#space-scan').disabled = false; $('#space-scan').replaceChildren(ic('search', 17), 'Проверить'); return; }
    $('#space-scan').disabled = false;
    $('#space-scan').replaceChildren(ic('x', 17), 'Остановить');
    box.classList.remove('hidden');
    const dupPhase = st.phase === 'dups';
    const fill = el('i');
    fill.style.width = dupPhase && st.hashTotal ? `${Math.round((st.hashed / st.hashTotal) * 100)}%` : '35%';
    box.replaceChildren(el('div', { class: 'space-prog' },
      el('div', { class: 'row' }, el('div', { class: 'spinner' }), el('div', { class: 'spacer' },
        el('b', { text: dupPhase ? 'Сравниваю похожие файлы…' : 'Считаю, что сколько занимает…' }),
        el('div', { class: 'muted small', text: `${(st.files || 0).toLocaleString('ru-RU')} файлов · ${fmtSz(st.bytes || 0)}${st.current && !dupPhase ? ' · ' + st.current : ''}` }))),
      el('div', { class: 'bar' + (dupPhase ? '' : ' indet') }, fill)));
  }

  async function spaceView(dir = spaceDir) {
    let v;
    try { v = await api('space-view', { dir }); } catch (e) { return; }
    renderProgress(v.status);
    const r = v.result;
    $('#space-result').classList.toggle('hidden', !r);
    if (!r) return;
    $('#space-title').textContent = `${r.root} — ${fmtSz(r.bytes)} в ${r.files.toLocaleString('ru-RU')} файлах`;
    $('#space-sub').textContent = `Проверено ${new Date(r.finished).toLocaleString('ru-RU')}. Отметьте ненужное — удаление только по кнопке и по умолчанию в корзину.`;
    renderMap(r.map);
    renderTop(r.top);
    renderDups(r.dups, r.dupWasted, r.dupGroups);
    updateSel();
  }

  /** Раскладка «квадратами» (squarified treemap). */
  function squarify(items, x, y, w, h) {
    const out = [];
    const total = items.reduce((s, i) => s + i.size, 0) || 1;
    const scaled = items.map((i) => ({ ...i, area: (i.size / total) * w * h }));
    let rect = { x, y, w, h };
    let row = [];
    const worst = (r, side) => { const s = r.reduce((a, i) => a + i.area, 0); const mx = Math.max(...r.map((i) => i.area)); const mn = Math.min(...r.map((i) => i.area)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
    const layout = (r) => {
      const s = r.reduce((a, i) => a + i.area, 0);
      if (rect.w >= rect.h) {
        const cw = s / rect.h; let cy = rect.y;
        for (const i of r) { const ch = i.area / cw; out.push({ ...i, x: rect.x, y: cy, w: cw, h: ch }); cy += ch; }
        rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
      } else {
        const ch = s / rect.w; let cx = rect.x;
        for (const i of r) { const cw = i.area / ch; out.push({ ...i, x: cx, y: rect.y, w: cw, h: ch }); cx += cw; }
        rect = { x: rect.x, y: rect.y + ch, w: rect.w, h: rect.h - ch };
      }
    };
    for (const it of scaled.filter((i) => i.area > 0)) {
      const side = Math.min(rect.w, rect.h);
      if (!row.length || worst([...row, it], side) <= worst(row, side)) row.push(it);
      else { layout(row); row = [it]; }
    }
    if (row.length) layout(row);
    return out;
  }

  function renderMap(map) {
    const box = $('#space-map');
    if (!map) { box.replaceChildren(); return; }
    spaceDir = map.path;
    $('#space-crumbs').replaceChildren(...map.crumbs.flatMap((c, i) => [i ? el('span', { class: 'muted', text: '›' }) : null, el('button', { onclick: () => spaceView(c.path) }, c.name)]).filter(Boolean),
      el('span', { class: 'muted small', text: ` · ${fmtSz(map.size)}` }));
    const W = box.clientWidth || 900; const H = box.clientHeight || 380;
    const cells = squarify(map.items.filter((i) => i.size > 0), 0, 0, W, H);
    box.replaceChildren(...cells.map((c, i) => {
      const d = el('div', { class: 'tm-cell' + (c.dir ? '' : ' file'), title: `${c.name} — ${fmtSz(c.size)}` },
        c.w > 60 && c.h > 30 ? el('b', { text: c.name }) : null, c.w > 60 && c.h > 46 ? el('span', { text: fmtSz(c.size) }) : null);
      const col = COLORS[i % COLORS.length];
      Object.assign(d.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px', background: `linear-gradient(135deg, ${col}, ${col}aa)` });
      if (c.dir) d.addEventListener('click', () => spaceView(c.path));
      return d;
    }));
  }

  const isSystemFile = (p) => /\\(pagefile|hiberfil|swapfile)\.sys$|\\Windows\\/i.test(p);
  function fileRow(f, size, label = null) {
    const locked = isSystemFile(f);
    const cb = el('input', { type: 'checkbox', disabled: locked });
    cb.checked = selected.has(f);
    cb.addEventListener('change', () => { if (cb.checked) selected.set(f, size); else selected.delete(f); updateSel(); });
    const name = f.split(/[\\/]/).pop();
    return el('label', { class: 'sp-row' + (locked ? ' locked' : ''), 'data-tip': locked ? 'Системный файл — удалять нельзя' : f },
      cb, el('div', { class: 'sp-name' }, el('b', { text: label || name }), el('span', { text: f })), el('span', { class: 'sp-size', text: fmtSz(size) }));
  }

  function renderTop(top) {
    $('#space-top').replaceChildren(...(top.length ? top.map((f) => fileRow(f.path, f.size)) : [el('p', { class: 'muted', text: 'Нет данных' })]));
  }

  function renderDups(dups, wasted, groups) {
    $('#space-dup-sum').textContent = groups ? `${groups} групп · лишнее ${fmtSz(wasted)}` : '';
    if (!dups.length) { $('#space-dups').replaceChildren(el('p', { class: 'muted', text: 'Одинаковых файлов (от 1 МБ) не найдено.' })); return; }
    $('#space-dups').replaceChildren(
      el('button', { class: 'btn sm mb6', 'data-tip': 'Отметить все копии, кроме первой в каждой группе (оригинал останется)', onclick: () => { for (const g of dups) g.files.slice(1).forEach((f) => { if (!isSystemFile(f)) selected.set(f, g.size); }); spaceView(); } }, ic('check', 14), 'Отметить лишние копии'),
      ...dups.map((g) => el('div', { class: 'dup-group' },
        el('div', { class: 'dup-head' }, el('span', { text: `${g.files.length} одинаковых файла по ${fmtSz(g.size)}${g.exact ? '' : ' (сравнение по частям)'}` }), el('b', { text: `лишнее ${fmtSz(g.wasted)}` })),
        ...g.files.map((f) => fileRow(f, g.size)))));
  }

  function updateSel() {
    const n = selected.size;
    const total = [...selected.values()].reduce((s, x) => s + x, 0);
    $('#space-sel').textContent = n ? `Выбрано: ${n} · ${fmtSz(total)}` : 'Ничего не выбрано';
    $('#space-delete').disabled = !n;
  }

  async function spaceDelete() {
    const paths = [...selected.keys()];
    const permanent = $('#space-permanent').checked;
    const total = [...selected.values()].reduce((s, x) => s + x, 0);
    const list = el('div', { class: 'confirm-list' }, paths.slice(0, 12).map((p) => el('div', { class: 'mono-path', text: p })), paths.length > 12 ? el('div', { class: 'muted small', text: `…и ещё ${paths.length - 12}` }) : null);
    const ok = await openModal([el('h3', { text: `Удалить ${paths.length} файлов (${fmtSz(total)})?` }),
      el('p', { text: permanent ? 'Файлы будут удалены НАВСЕГДА — восстановить их будет нельзя.' : 'Файлы попадут в корзину — их можно будет восстановить.' }), list,
      el('div', { class: 'row end mt' }, el('button', { class: 'btn', onclick: () => closeModal(false) }, 'Отмена'), el('button', { class: 'btn danger', onclick: () => closeModal(true) }, ic('trash', 16), permanent ? 'Удалить навсегда' : 'В корзину'))]);
    if (!ok) return;
    let r;
    try { r = await api('space-delete', { paths, permanent }); } catch (e) { toast(e.message, 'err'); return; }
    const done = r.filter((x) => x.ok);
    for (const x of done) selected.delete(x.path);
    const failed = r.filter((x) => !x.ok);
    toast(`Удалено: ${done.length}${failed.length ? `, не получилось: ${failed.length} (${failed[0].error})` : ''}`, failed.length ? 'err' : 'ok');
    spaceView();
  }

  $('#space-scan').addEventListener('click', async () => {
    try {
      const st = await api('space-view', {});
      if (st.status && st.status.state === 'scanning') { await api('space-cancel'); return; }
      selected.clear(); spaceDir = null;
      renderProgress(await api('space-start', { root: spaceRoot }));
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#space-delete').addEventListener('click', spaceDelete);
  window.pcc.on('space', onSpace);

  // ---------------- оформление ----------------
  const ACCENTS = [['indigo', '#6d7cff', '#22d3ee', 'Индиго'], ['violet', '#a78bfa', '#f472b6', 'Фиалка'], ['blue', '#3b82f6', '#06b6d4', 'Синий'], ['emerald', '#10b981', '#22d3ee', 'Изумруд'],
    ['gold', '#f59e0b', '#eab308', 'Золото'], ['orange', '#fb923c', '#f43f5e', 'Закат'], ['red', '#ef4444', '#f97316', 'Красный'], ['pink', '#ec4899', '#8b5cf6', 'Розовый']];

  function applyTheme(ui) {
    const t = (ui && ui.theme) || 'dark';
    const a = (ui && ui.accent) || 'indigo';
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = t === 'system' ? (dark ? 'dark' : 'light') : t;
    document.documentElement.dataset.accent = a;
    try { localStorage.setItem('pcfc-theme', t); localStorage.setItem('pcfc-accent', a); } catch (e) { /* ignore */ }
    $$('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === t));
    $$('#accent-list .accent-dot').forEach((b) => b.classList.toggle('active', b.dataset.accent === a));
  }

  async function setTheme(patch) {
    const cur = (STATE && STATE.config && STATE.config.ui) || {};
    const ui = { theme: cur.theme || 'dark', accent: cur.accent || 'indigo', ...patch };
    applyTheme(ui);
    try { const r = await api('set-theme', ui); if (STATE && STATE.config) STATE.config.ui = r; } catch (e) { toast(e.message, 'err'); }
    if (page === 'overview') drawChart();
  }

  $('#accent-list').replaceChildren(...ACCENTS.map(([id, c1, c2, name]) => { const d = el('button', { class: 'accent-dot', 'data-accent': id, 'data-tip': name, onclick: () => setTheme({ accent: id }) }); d.style.background = `linear-gradient(135deg, ${c1}, ${c2})`; return d; }));
  $$('#theme-seg button').forEach((b) => b.addEventListener('click', () => setTheme({ theme: b.dataset.theme })));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (STATE && STATE.config) applyTheme(STATE.config.ui); });

  // ---------------- безопасность: USB и тревожная кнопка ----------------
  async function security() {
    try {
      const ev = await api('usb-events');
      $('#usb-log').replaceChildren(...(ev.length ? ev.slice(0, 15).map((e) => el('div', {}, el('span', { text: fmtDay(e.ts) }), el('span', { text: `${e.kind === 'add' ? 'подключено' : 'отключено'}: ${e.name}${e.info ? ' · ' + e.info : ''}` }))) : [el('div', {}, el('span', { class: 'muted', text: 'Подключений USB пока не было.' }))]));
    } catch (e) { /* ignore */ }
    try {
      const st = await api('panic-state');
      const b = $('#panic-btn');
      b.classList.toggle('on', !!st.active);
      b.replaceChildren(ic(st.active ? 'check' : 'siren', 16), st.active ? 'Снять тревогу' : 'Проверить');
      b.dataset.active = st.active ? '1' : '';
    } catch (e) { /* ignore */ }
  }
  $('#panic-btn').addEventListener('click', async () => {
    const b = $('#panic-btn');
    if (b.dataset.active) { try { await api('panic-release'); toast('Тревога снята: микрофон и камеры возвращены'); } catch (e) { toast(e.message, 'err'); } security(); return; }
    if (!(await confirmModal('Проверить тревожную кнопку?', 'Компьютер сделает фото с веб-камеры, выключит микрофон, отключит веб-камеры и заблокируется. Снять тревогу можно здесь же, с телефона или командой /panic_off.', 'Включить тревогу'))) return;
    try { await api('panic-trigger'); } catch (e) { toast(e.message, 'err'); }
    security();
  });
  window.pcc.on('usb', () => { if (page === 'settings') security(); });
  window.addEventListener('resize', () => { if (page === 'hardware') drawTemps(); });
  $$('#temps-range button').forEach((b) => b.addEventListener('click', () => { tempHours = Number(b.dataset.h); $$('#temps-range button').forEach((x) => x.classList.toggle('active', x === b)); temps(); }));

  return { hardware, temps, spaceShow, applyTheme, security };
})();
