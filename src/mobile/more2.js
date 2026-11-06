'use strict';
// Телефон: музыка и микшер, игры, безопасность (тревожная кнопка, USB), место на диске, ассистент, виджет,
// а в «Железе» — графики температур и синие экраны.
const M2 = (() => {
  const fmtT = (s) => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
  const dur = (s) => { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return h ? `${h} ч ${m} мин` : `${m} мин`; };
  const fmtSz = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} ТБ` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} ГБ` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} МБ` : `${Math.max(1, Math.round(b / 1e3))} КБ`);
  const when = (ts) => new Date(ts * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let paneTimer = null;
  const cover = (k) => (k ? `/api/music/cover?k=${encodeURIComponent(k)}` : null);
  function stopPaneTimer() { clearInterval(paneTimer); paneTimer = null; }
  function openPane(p) { switchTab('more'); morePane = p; loadMore(); }

  async function control(app, action, value) {
    haptic(10);
    try { await api('/api/music/control', { json: { app, action, value } }); } catch (e) { toast(e.message, 'err'); }
    setTimeout(() => { if (morePane === 'music') music(); homeNow(); }, 500);
  }

  // ---------------- главная: «Сейчас играет» ----------------
  let homeSig = '';
  async function homeNow() {
    let st;
    try { st = await api('/api/music'); } catch (e) { return; }
    const s = st.sessions && st.sessions[0];
    const box = $('#m-now');
    const sig = s ? [s.app, s.title, s.artist, s.playing, s.cover].join('|') : '';
    if (sig === homeSig) return;
    homeSig = sig;
    if (!s || !s.title) { box.replaceChildren(); return; }
    const art = cover(s.cover);
    box.replaceChildren(el('div', { class: 'm-nowcard', onclick: (e) => { if (!e.target.closest('button')) openPane('music'); } },
      el('div', { class: 'm-now-art' }, art ? el('img', { src: art, alt: '' }) : ic('music', 22)),
      el('div', { class: 'm-now-text' }, el('b', { text: s.title }), el('small', { text: [s.artist, s.appName].filter(Boolean).join(' · ') })),
      el('button', { class: 'round-btn', 'aria-label': 'Пауза', onclick: () => control(s.app, 'toggle') }, ic(s.playing ? 'pause' : 'play', 20)),
      s.can.next ? el('button', { class: 'round-btn', 'aria-label': 'Следующий', onclick: () => control(s.app, 'next') }, ic('next', 20)) : null));
  }

  // ---------------- музыка ----------------
  let tick = null;
  let musicSig = '';
  async function music() {
    let st;
    try { st = await api('/api/music'); } catch (e) { toast(e.message, 'err'); return; }
    const sig = JSON.stringify((st.sessions || []).map((x) => [x.app, x.title, x.artist, x.status, x.cover, x.window, x.shuffle, x.repeat, Math.round(x.position / 4)]));
    if (sig === musicSig && $('#m-player').children.length) { mixer(); return; }
    musicSig = sig;
    const box = $('#m-player');
    if (!st.available) { box.replaceChildren(el('div', { class: 'card muted', text: 'Сведения о музыке доступны в Windows 10 и 11.' })); return; }
    const s = st.sessions[0];
    if (!s) {
      box.replaceChildren(el('div', { class: 'card m-empty-music' }, ic('music', 34), el('b', { text: 'Сейчас ничего не играет' }), el('p', { class: 'muted small', text: 'Включите музыку или видео на компьютере — здесь появятся название, исполнитель и обложка.' })));
      $('#m-players').replaceChildren();
    } else {
      const art = cover(s.cover);
      const fill = el('i', { id: 'm-pfill' });
      const bar = el('div', { class: 'm-pbar' }, fill);
      if (s.can.seek) bar.addEventListener('click', (e) => { const r = bar.getBoundingClientRect(); control(s.app, 'seek', Math.round(((e.clientX - r.left) / r.width) * s.duration)); });
      const card = el('div', { class: 'card m-player' + (s.playing ? ' playing' : '') },
        el('div', { class: 'm-pbg' }),
        el('div', { class: 'm-part' }, art ? el('img', { src: art, alt: '' }) : ic('music', 60)),
        el('div', { class: 'm-papp' }, s.icon ? el('img', { src: s.icon, alt: '' }) : ic('music', 14), el('b', { text: s.appName }), el('span', { class: 'pill ' + (s.playing ? 'ok' : ''), text: s.statusText })),
        el('h2', { class: 'm-ptitle', text: s.title || 'Без названия' }),
        el('div', { class: 'm-partist', text: s.artist || s.subtitle || '' }),
        s.album ? el('div', { class: 'm-pmeta', text: `💿 ${s.album}${s.track ? ` · трек ${s.track}${s.tracks ? ' из ' + s.tracks : ''}` : ''}` }) : null,
        (s.genres || []).length ? el('div', { class: 'm-pmeta', text: '🏷 ' + s.genres.join(', ') }) : null,
        s.window ? el('div', { class: 'm-pmeta', text: `🪟 Окно: «${s.window}»` }) : null,
        s.duration ? el('div', { class: 'm-ptime' }, el('span', { id: 'm-ppos', text: fmtT(s.position) }), bar, el('span', { text: fmtT(s.duration) })) : null,
        el('div', { class: 'm-pctl' },
          s.can.shuffle ? el('button', { class: 'round-btn' + (s.shuffle ? ' on' : ''), onclick: () => control(s.app, 'shuffle', !s.shuffle) }, ic('shuffle', 20)) : null,
          el('button', { class: 'round-btn', disabled: !s.can.prev, onclick: () => control(s.app, 'prev') }, ic('prev', 22)),
          el('button', { class: 'round-btn accent big', onclick: () => control(s.app, 'toggle') }, ic(s.playing ? 'pause' : 'play', 28)),
          el('button', { class: 'round-btn', disabled: !s.can.next, onclick: () => control(s.app, 'next') }, ic('next', 22)),
          s.can.repeat ? el('button', { class: 'round-btn' + (s.repeat && s.repeat !== 'None' ? ' on' : ''), onclick: () => control(s.app, 'repeat', s.repeat === 'None' ? 2 : s.repeat === 'List' ? 1 : 0) }, ic('repeat', 20)) : null));
      if (art) card.style.setProperty('--cover', `url("${art}")`);
      box.replaceChildren(card);
      const base = { pos: s.position, at: Date.now(), dur: s.duration, playing: s.playing };
      clearInterval(tick);
      const upd = () => { if (!base.dur) return; const pos = Math.min(base.dur, base.pos + (base.playing ? (Date.now() - base.at) / 1000 : 0)); const f = $('#m-pfill'); const p = $('#m-ppos'); if (f) f.style.width = (pos / base.dur) * 100 + '%'; if (p) p.textContent = fmtT(pos); };
      upd();
      tick = setInterval(() => { if (morePane !== 'music') { clearInterval(tick); return; } upd(); }, 500);
      $('#m-players').replaceChildren(...st.sessions.slice(1).map((o) => el('div', { class: 'card m-mini' },
        el('div', { class: 'm-mini-text' }, el('b', { text: o.title || 'Без названия' }), el('small', { class: 'muted', text: [o.artist, o.appName, o.statusText].filter(Boolean).join(' · ') })),
        el('button', { class: 'round-btn', onclick: () => control(o.app, 'toggle') }, ic(o.playing ? 'pause' : 'play', 18)))));
    }
    mixer();
  }

  let mixBusy = false;
  async function mixer() {
    if (mixBusy) return;
    let mx;
    try { mx = await api('/api/mixer'); } catch (e) { return; }
    if (!mx.available || mx.noDevice) { $('#m-mixer').replaceChildren(el('p', { class: 'muted', text: mx.noDevice ? 'Нет устройства вывода звука.' : 'Микшер доступен в Windows.' })); return; }
    let t = null;
    const row = (name, title, icon, value, muted, peak, iconEl) => {
      const fill = el('div', { class: 'm-mix-fill' });
      fill.style.width = value + '%';
      const r = el('input', { type: 'range', min: '0', max: '100', value: String(value), class: 'm-mix-range' });
      const track = el('div', { class: 'm-mix-track' + (muted ? ' muted' : ''), 'data-key': name === '*' ? '*' : name.toLowerCase(), 'data-vol': String(value) }, fill, el('div', { class: 'm-mix-level' }), r);
      const val = el('b', { class: 'm-mix-val', text: muted ? 'выкл' : value + '%' });
      r.addEventListener('touchstart', () => { mixBusy = true; }, { passive: true });
      r.addEventListener('change', () => { setTimeout(() => { mixBusy = false; }, 600); });
      r.addEventListener('input', () => {
        val.textContent = r.value + '%';
        fill.style.width = r.value + '%';
        track.dataset.vol = r.value;
        clearTimeout(t);
        t = setTimeout(() => (name === '*' ? api('/api/mixer/master', { json: { level: Number(r.value), mute: false } }) : api('/api/mixer/set', { json: { name, level: Number(r.value), mute: false } })).catch((e) => toast(e.message, 'err')), 120);
      });
      return el('div', { class: 'm-mix' + (name === '*' ? ' master' : '') },
        el('div', { class: 'm-mix-top' }, el('span', { class: 'm-mix-ic' }, iconEl || ic(icon, 18)), el('b', { class: 'm-mix-name', text: title }), val,
          el('button', { class: 'round-btn sm' + (muted ? ' danger' : ''), onclick: async () => { haptic(8); await (name === '*' ? api('/api/mixer/master', { json: { mute: !muted } }) : api('/api/mixer/set', { json: { name, mute: !muted } })).catch((e) => toast(e.message, 'err')); mixer(); } }, ic(muted ? 'mute' : 'volUp', 16))),
        track);
    };
    $('#m-mixer').replaceChildren(row('*', 'Общая громкость', 'volUp', mx.master, mx.masterMuted, 0),
      ...mx.apps.map((a) => row(a.name, a.title, a.system ? 'bell' : 'music', a.volume, a.muted, a.peak, a.icon ? el('img', { src: a.icon, alt: '' }) : null)),
      mx.apps.length ? '' : el('p', { class: 'muted small', text: 'Сейчас ни одна программа не выводит звук.' }));
  }

  let peakBusy = false;
  async function peaks() {
    if (peakBusy || document.hidden || morePane !== 'music') return;
    peakBusy = true;
    try {
      const pk = await api('/api/mixer/peaks');
      for (const tr of document.querySelectorAll('#m-mixer .m-mix-track')) {
        const p = tr.classList.contains('muted') ? 0 : Math.min(1, (pk[tr.dataset.key] || 0) * 1.35);
        tr.querySelector('.m-mix-level').style.width = (Number(tr.dataset.vol) || 0) * p + '%';
      }
    } catch (e) { /* ignore */ } finally { peakBusy = false; }
  }
  let peakTimer = null;

  // ---------------- игры ----------------
  async function games() {
    let r;
    try { r = await api('/api/games?days=7'); } catch (e) { toast(e.message, 'err'); return; }
    const box = $('#m-games');
    if (!r.games.length) { box.replaceChildren(el('div', { class: 'card muted', text: 'За неделю игр не было. Время и средний FPS записываются сами, пока игра открыта на экране компьютера.' })); return; }
    const top = r.games[0].seconds;
    box.replaceChildren(
      el('div', { class: 'card m-games-hero' }, el('span', { class: 'muted small', text: 'Всего за 7 дней' }), el('b', { text: dur(r.total) }), r.now ? el('div', { class: 'm-game-now', text: `▶ Сейчас: ${r.now.title}${r.now.fps ? ` — ${r.now.fps} FPS` : ''}` }) : null),
      el('div', { class: 'card' }, r.games.map((g) => {
        const f = el('i');
        f.style.width = Math.max(3, (g.seconds / top) * 100) + '%';
        return el('div', { class: 'm-game' }, el('div', { class: 'm-game-top' }, el('b', { text: g.title }), el('span', { class: 'muted small', text: `${dur(g.seconds)}${g.avgFps ? ` · ${g.avgFps} FPS` : ''}` })), el('div', { class: 'bar' }, f));
      })));
  }

  // ---------------- безопасность ----------------
  async function security() {
    let st = { active: false };
    try { st = await api('/api/panic'); } catch (e) { /* ignore */ }
    $('#m-panic').replaceChildren(
      el('div', { class: 'm-panic-ic' + (st.active ? ' on' : '') }, ic('siren', 34)),
      el('b', { class: 'm-panic-title', text: st.active ? 'Тревога включена' : 'Тревожная кнопка' }),
      el('p', { class: 'muted small', text: st.active ? `С ${new Date(st.since * 1000).toLocaleTimeString('ru-RU')}. Микрофон и веб-камеры выключены, компьютер заблокирован.` : 'Одно нажатие: фото того, кто за компьютером, выключить микрофон и веб-камеры, заблокировать ПК. Всё обратимо.' }),
      st.active
        ? el('button', { class: 'btn big', onclick: async () => { try { await api('/api/panic', { json: { on: false } }); toast('Тревога снята'); } catch (e) { toast(e.message, 'err'); } security(); } }, ic('check', 18), 'Снять тревогу')
        : el('button', { class: 'btn danger big', onclick: async () => {
          if (!(await confirmSheet('Включить тревогу?', 'Компьютер сделает фото с веб-камеры, выключит микрофон, отключит веб-камеры и заблокируется.', 'Включить тревогу', true, 'siren'))) return;
          haptic(30);
          try { await api('/api/panic', { json: { on: true } }); toast('Тревога включена — подробности в Telegram'); } catch (e) { toast(e.message, 'err'); }
          security();
        } }, ic('siren', 18), 'Включить тревогу'));
    let ev = [];
    try { ev = await api('/api/usb'); } catch (e) { /* ignore */ }
    $('#m-usb').replaceChildren(...(ev.length ? ev.slice(0, 20).map((e) => el('div', { class: 'about-row m-usb-row' }, el('span', { text: when(e.ts) }), el('b', { class: 'wrap', text: `${e.kind === 'add' ? '➕' : '➖'} ${e.name}${e.info ? ' · ' + e.info : ''}` })))
      : [el('p', { class: 'muted small', text: 'Подключений пока не было. Когда к компьютеру подключат флешку, телефон или другое USB-устройство, придёт сообщение в Telegram.' })]));
  }

  // ---------------- место на диске ----------------
  let root = null;
  let dir = null;
  const sel = new Map();
  const isSys = (p) => /\\(pagefile|hiberfil|swapfile)\.sys$|\\Windows\\/i.test(p);

  async function space() {
    let roots = [];
    try { roots = await api('/api/space/roots'); } catch (e) { /* ignore */ }
    if (!root && roots.length) root = (roots.find((r) => /^C:/i.test(r.mount)) || roots[0]).mount;
    $('#m-space-roots').replaceChildren(...roots.map((r) => el('button', { class: 'chip-btn' + (r.mount === root ? ' active' : ''), onclick: () => { root = r.mount; space(); } }, `${r.mount} · ${fmtSz(r.free)} свободно`)));
    spaceView();
  }

  function fileRow(p, size) {
    const locked = isSys(p);
    const cb = el('input', { type: 'checkbox', disabled: locked });
    cb.checked = sel.has(p);
    cb.addEventListener('change', () => { if (cb.checked) sel.set(p, size); else sel.delete(p); updBar(); });
    return el('label', { class: 'm-sp-row' + (locked ? ' locked' : '') }, cb,
      el('div', { class: 'm-sp-name' }, el('b', { text: p.split(/[\\/]/).pop() }), el('small', { text: p })), el('span', { class: 'm-sp-size', text: fmtSz(size) }));
  }

  function updBar() {
    const n = sel.size;
    $('#m-space-bar').classList.toggle('hidden', !n);
    $('#m-space-sel').textContent = `Выбрано: ${n} · ${fmtSz([...sel.values()].reduce((s, x) => s + x, 0))}`;
  }

  async function spaceView() {
    let v;
    try { v = await api('/api/space' + (dir ? `?dir=${encodeURIComponent(dir)}` : '')); } catch (e) { return; }
    const st = v.status || {};
    const scanning = st.state === 'scanning';
    $('#m-space-scan').replaceChildren(ic(scanning ? 'x' : 'search', 18), scanning ? 'Остановить' : 'Проверить');
    $('#m-space-prog').replaceChildren(...(scanning ? [el('div', { class: 'm-sp-prog' }, el('div', { class: 'spinner' }), el('span', { class: 'small', text: `${st.phase === 'dups' ? 'Сравниваю похожие файлы' : 'Считаю'}… ${(st.files || 0).toLocaleString('ru-RU')} файлов · ${fmtSz(st.bytes || 0)}` }))] : []));
    if (scanning) { clearTimeout(spaceView.t); spaceView.t = setTimeout(() => { if (morePane === 'space') spaceView(); }, 1200); }
    const r = v.result;
    if (!r) { $('#m-space-res').replaceChildren(); return; }
    $('#m-space-sub').textContent = `${r.root}: ${fmtSz(r.bytes)} в ${r.files.toLocaleString('ru-RU')} файлах. Отметьте ненужное — удаление по кнопке, по умолчанию в корзину.`;
    const map = r.map;
    const parts = [];
    if (map) {
      dir = map.path;
      const max = map.items.length ? map.items[0].size : 1;
      parts.push(el('div', { class: 'section-title', text: 'Папки' }),
        el('div', { class: 'card' },
          el('div', { class: 'm-crumbs' }, map.crumbs.map((c) => el('button', { class: 'chip-btn sm', onclick: () => { dir = c.path; spaceView(); } }, c.name))),
          map.items.slice(0, 25).map((it) => {
            const f = el('i');
            f.style.width = Math.max(2, (it.size / max) * 100) + '%';
            return el('div', { class: 'm-dir' + (it.dir ? ' click' : ''), onclick: () => { if (it.dir) { dir = it.path; spaceView(); } } },
              el('div', { class: 'm-dir-top' }, el('span', {}, it.dir ? ic('folder', 16) : ic('file', 16), el('b', { text: it.name })), el('span', { class: 'm-sp-size', text: fmtSz(it.size) })), el('div', { class: 'bar' }, f));
          })));
    }
    parts.push(el('div', { class: 'section-title', text: 'Самые большие файлы' }), el('div', { class: 'card pad8' }, r.top.slice(0, 40).map((f) => fileRow(f.path, f.size))));
    parts.push(el('div', { class: 'section-title', text: r.dupGroups ? `Одинаковые файлы · лишнее ${fmtSz(r.dupWasted)}` : 'Одинаковые файлы' }));
    if (r.dups.length) {
      parts.push(el('button', { class: 'btn', onclick: () => { for (const g of r.dups) g.files.slice(1).forEach((f) => { if (!isSys(f)) sel.set(f, g.size); }); spaceView(); } }, ic('check', 16), 'Отметить лишние копии'));
      parts.push(...r.dups.slice(0, 30).map((g) => el('div', { class: 'card pad8 m-dup' }, el('div', { class: 'm-dup-head muted small', text: `${g.files.length} копии по ${fmtSz(g.size)} · лишнее ${fmtSz(g.wasted)}` }), g.files.map((f) => fileRow(f, g.size)))));
    } else parts.push(el('p', { class: 'muted small', text: 'Одинаковых файлов (от 1 МБ) не найдено.' }));
    $('#m-space-res').replaceChildren(...parts);
    updBar();
  }

  async function spaceDelete() {
    const paths = [...sel.keys()];
    const total = [...sel.values()].reduce((s, x) => s + x, 0);
    const choice = await openSheet(`Удалить ${paths.length} файлов (${fmtSz(total)})?`, [
      el('div', { class: 'confirm-files' }, paths.slice(0, 8).map((p) => el('div', { class: 'mono small', text: p })), paths.length > 8 ? el('div', { class: 'muted small', text: `…и ещё ${paths.length - 8}` }) : null),
      el('div', { class: 'sheet-options' },
        el('button', { class: 'btn primary', onclick: () => closeSheet('trash') }, ic('trash', 18), 'В корзину (можно вернуть)'),
        el('button', { class: 'btn danger', onclick: () => closeSheet('forever') }, ic('alert', 18), 'Удалить навсегда'),
        el('button', { class: 'btn', onclick: () => closeSheet(null) }, 'Отмена'))]);
    if (!choice) return;
    let r;
    try { r = await api('/api/space/delete', { json: { paths, permanent: choice === 'forever' } }); } catch (e) { toast(e.message, 'err'); return; }
    const ok = r.filter((x) => x.ok);
    ok.forEach((x) => sel.delete(x.path));
    const bad = r.filter((x) => !x.ok);
    toast(`Удалено: ${ok.length}${bad.length ? `, не получилось: ${bad.length} (${bad[0].error})` : ''}`, bad.length ? 'err' : 'ok');
    spaceView();
  }

  $('#m-space-scan').addEventListener('click', async () => {
    try {
      const v = await api('/api/space');
      if (v.status && v.status.state === 'scanning') { await api('/api/space/cancel', { json: {} }); spaceView(); return; }
      sel.clear(); dir = null;
      await api('/api/space/start', { json: { root } });
      spaceView();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#m-space-del').addEventListener('click', spaceDelete);

  // ---------------- ассистент ----------------
  const canRecordHere = () => !!(navigator.mediaDevices && window.isSecureContext && window.MediaRecorder);
  function speak(text) {
    try { const u = new SpeechSynthesisUtterance(text); u.lang = 'ru-RU'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* нет озвучки */ }
  }
  function chat(kind, text, extra = null) {
    const box = $('#m-chat');
    const m = el('div', { class: 'm-msg ' + kind }, el('span', { text }), extra);
    box.append(m);
    setTimeout(() => m.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  }
  async function ask(text, confirm = false) {
    if (!text) return;
    if (!confirm) chat('me', text);
    let r;
    try { r = await api('/api/assistant', { json: { text, confirm } }); } catch (e) { chat('pc err', e.message); return; }
    showReply(r);
  }
  function showReply(r) {
    if (r.heard && r.fromAudio) chat('me', r.heard);
    if (r.needConfirm) {
      const btns = el('div', { class: 'm-msg-btns' },
        el('button', { class: 'btn sm', onclick: (e) => { e.target.closest('.m-msg-btns').remove(); chat('pc', 'Отменено.'); } }, 'Нет'),
        el('button', { class: 'btn primary sm', onclick: (e) => { e.target.closest('.m-msg-btns').remove(); ask(r.heard, true); } }, 'Да, выполнить'));
      chat('pc', r.reply, btns);
    } else chat('pc' + (r.ok ? '' : ' err'), r.reply);
    if (r.reply) speak(r.reply);
  }
  let recorder = null;
  async function micClick() {
    haptic(15);
    if (SHELL === 'android') {
      // Микрофон доступен только на локальной странице приложения — уходим туда и возвращаемся обратно
      const back = `${location.origin}/?shell=android`;
      location.href = `http://localhost/voice.html#pc=${encodeURIComponent(location.origin)}&t=${encodeURIComponent(token)}&back=${encodeURIComponent(back)}`;
      return;
    }
    if (!canRecordHere()) {
      $('#m-asst-text').focus();
      toast(IS_IOS ? 'Нажмите 🎤 на клавиатуре и продиктуйте команду' : 'Нажмите микрофон на клавиатуре и продиктуйте команду', 'info');
      return;
    }
    if (recorder) { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { toast('Нет доступа к микрофону', 'err'); return; }
    const chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('#m-asst-mic').classList.remove('rec');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      recorder = null;
      $('#m-asst-hint').textContent = 'Распознаю на компьютере…';
      try {
        const r = await api('/api/assistant/audio', { body: blob, headers: { 'Content-Type': blob.type } });
        showReply({ ...r, fromAudio: true });
      } catch (e) { chat('pc err', e.message); }
      hint();
    };
    recorder.start();
    $('#m-asst-mic').classList.add('rec');
    $('#m-asst-hint').textContent = 'Слушаю… нажмите ещё раз, когда закончите';
    setTimeout(() => { if (recorder && recorder.state === 'recording') recorder.stop(); }, 12000);
  }
  function hint() {
    $('#m-asst-hint').textContent = SHELL === 'android' || canRecordHere()
      ? 'Нажмите и скажите: «выключи компьютер через полчаса», «что сейчас играет?», «громкость 30»…'
      : 'Напишите команду или нажмите 🎤 на клавиатуре и продиктуйте. Например: «что сейчас играет?», «громкость 30».';
  }
  $('#m-asst-mic').addEventListener('click', micClick);
  $('#m-asst-send').addEventListener('click', () => { const t = $('#m-asst-text').value.trim(); $('#m-asst-text').value = ''; ask(t); });
  $('#m-asst-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#m-asst-send').click(); } });

  // ---------------- виджет ----------------
  function widget() {
    const box = $('#m-widget');
    if (SHELL === 'android') {
      box.replaceChildren(el('div', { class: 'card m-widget-hero' },
        el('div', { class: 'm-wpreview' }, el('div', { class: 'm-wp-head' }, el('span', { class: 'm-wp-ic', text: '🖥' }), el('div', {}, el('b', { text: INFO ? INFO.pcName : 'Мой ПК' }), el('small', { text: '● в сети' }))),
          el('div', { class: 'm-wp-row' }, el('span', { text: 'ЦП 12% · 45°' }), el('span', { text: 'ОЗУ 41%' }), el('span', { text: 'Видео 52°' })),
          el('div', { class: 'm-wp-btns' }, ['🔒', '⏯', '🌙', '⏻'].map((x) => el('span', { text: x })))),
        el('p', { class: 'muted small', text: 'Виджет на главном экране: загрузка и температуры компьютера, что играет, и кнопки — блокировка, пауза, сон, выключение (с подтверждением).' }),
        el('button', { class: 'btn primary big', onclick: async () => {
          let k;
          try { k = await api('/api/widget/key', { json: {} }); } catch (e) { toast(e.message, 'err'); return; }
          location.href = `http://localhost/#widget=${encodeURIComponent(JSON.stringify({ url: location.origin, key: k.key, name: k.pcName }))}`;
        } }, ic('plus', 18), 'Добавить виджет на экран')));
      return;
    }
    const steps = [
      'Нажмите «Создать ссылки» ниже.',
      'Откройте приложение «Команды» → «+» (новая команда).',
      'Добавьте действие «Получить содержимое URL» и вставьте ссылку «Состояние».',
      'Добавьте действие «Показать результат». Назовите команду «Мой ПК».',
      'На экране «Домой» удерживайте пустое место → «+» → «Команды» → выберите «Мой ПК». Нажатие покажет загрузку и температуры.',
      'Так же можно сделать кнопки «Заблокировать» и «Выключить»: в «Получить содержимое URL» вставьте их ссылку и выберите метод POST.',
    ];
    const urls = el('div', { id: 'm-wurls' });
    box.replaceChildren(el('div', { class: 'card' },
      el('div', { class: 'card-title' }, ic('apple', 18), 'Виджет на iPhone'),
      el('p', { class: 'muted small', text: 'iPhone не разрешает веб-приложениям ставить «живые» виджеты. Но виджет можно сделать через встроенное приложение «Команды» — это 2 минуты:' }),
      el('ol', { class: 'm-steps' }, steps.map((s) => el('li', { text: s }))),
      el('button', { class: 'btn primary big', onclick: async () => {
        let k;
        try { k = await api('/api/widget/key', { json: {} }); } catch (e) { toast(e.message, 'err'); return; }
        const q = `k=${encodeURIComponent(k.key)}`;
        const field = (label, url, note) => { const inp = el('input', { class: 'input mono small', readonly: true, value: url }); inp.addEventListener('focus', () => inp.select()); return el('div', { class: 'm-wurl' }, el('b', { text: label }), note ? el('small', { class: 'muted', text: note }) : null, inp); };
        urls.replaceChildren(
          field('Состояние', `${location.origin}/api/widget/text?${q}`, 'метод GET (по умолчанию)'),
          field('Заблокировать', `${location.origin}/api/widget/action?${q}&action=lock`, 'метод POST'),
          field('Пауза / играть', `${location.origin}/api/widget/action?${q}&action=play_pause`, 'метод POST'),
          field('Выключить', `${location.origin}/api/widget/action?${q}&action=shutdown`, 'метод POST — добавьте «Запросить подтверждение» перед ним'),
          el('p', { class: 'muted small', text: 'Нажмите на поле → «Скопировать». Ссылки работают в домашнем Wi-Fi. Новые ссылки отключают старые.' }));
      } }, ic('link', 18), 'Создать ссылки'), urls));
  }

  // ---------------- железо: температуры и сбои ----------------
  let tHours = 24;
  const COLORS = ['#f97316', '#10b981', '#22d3ee', '#a855f7', '#f472b6', '#eab308'];
  async function temps() {
    let t;
    try { t = await api(`/api/temps?hours=${tHours}`); } catch (e) { return; }
    const list = [];
    if (t.cpu.length) list.push(['Процессор', t.cpu, t.stats.cpu, t.limits.cpu]);
    if (t.gpu.length) list.push(['Видеокарта', t.gpu, t.stats.gpu, t.limits.gpu]);
    for (const [n, pts] of Object.entries(t.disks)) list.push([n, pts, t.stats.disks[n], 60]);
    $('#m-temps-legend').replaceChildren(...list.map(([n], i) => { const b = el('i'); b.style.background = COLORS[i % COLORS.length]; return el('span', {}, b, n); }));
    $('#m-temps-stats').replaceChildren(...list.map(([n, , st, lim]) => el('div', { class: 'about-row' }, el('span', { text: n }), el('b', { class: st && st.max >= lim ? 'hot-text' : '', text: st ? `макс. ${st.max}° · ср. ${st.avg}°` : '—' }))));
    const c = $('#m-temps-chart');
    const dpr = devicePixelRatio || 1;
    const w = c.clientWidth; const h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const all = list.flatMap(([, pts]) => pts.map((p) => p[2]));
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--dim'); g.font = '11px -apple-system, sans-serif';
    if (!all.length) { g.fillText('Данные собираются…', 10, h / 2); return; }
    const lo = Math.max(0, Math.floor((Math.min(...list.flatMap(([, pts]) => pts.map((p) => p[1]))) - 5) / 10) * 10);
    const hi = Math.max(lo + 30, Math.ceil((Math.max(...all) + 5) / 10) * 10);
    const t0 = t.since; const t1 = Date.now() / 1000;
    const x = (ts) => 28 + (w - 32) * ((ts - t0) / (t1 - t0));
    const y = (v) => 6 + (h - 24) * (1 - (v - lo) / (hi - lo));
    g.strokeStyle = css.getPropertyValue('--line');
    for (let v = lo; v <= hi; v += 10) { g.beginPath(); g.moveTo(28, y(v)); g.lineTo(w - 4, y(v)); g.stroke(); g.fillText(v + '°', 0, y(v) + 4); }
    list.forEach(([, pts], i) => {
      g.beginPath();
      let prev = null;
      for (const p of pts) { if (!prev || p[0] - prev[0] > Math.max(1800, (t1 - t0) / 40)) g.moveTo(x(p[0]), y(p[1])); else g.lineTo(x(p[0]), y(p[1])); prev = p; }
      g.strokeStyle = COLORS[i % COLORS.length]; g.lineWidth = 2; g.stroke();
    });
    const l = (ts) => (tHours > 24 ? new Date(ts * 1000).toLocaleDateString('ru-RU', { weekday: 'short' }) : new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }));
    g.fillText(l(t0), 28, h - 4); g.fillText(l(t1), w - 40, h - 4);
  }
  $$('#m-temps-range button').forEach((b) => b.addEventListener('click', () => { tHours = Number(b.dataset.h); $$('#m-temps-range button').forEach((x) => x.classList.toggle('active', x === b)); temps(); }));

  async function crashes() {
    let list;
    try { list = await api('/api/crashes'); } catch (e) { return; }
    if (!list.length) {
      $('#m-crashes').replaceChildren(el('div', { class: 'card m-cr-empty' }, el('div', { class: 'm-cr-empty-ic' }, ic('shield', 26)),
        el('div', {}, el('b', { text: 'Компьютер работает стабильно' }), el('p', { class: 'muted small', text: 'За 90 дней не было синих экранов и внезапных выключений.' }))));
      return;
    }
    $('#m-crashes').replaceChildren(...list.slice(0, 5).map((c) => {
      const bs = c.kind === 'bsod';
      return el('div', { class: 'card m-cr ' + (bs ? 'bsod' : 'power') },
        el('div', { class: 'm-cr-top' }, el('div', { class: 'm-cr-ic' }, ic(bs ? 'crash' : 'zap', 18)),
          el('div', { class: 'm-cr-title' }, el('b', { text: c.title }), el('small', { class: 'muted', text: when(c.ts) }))),
        c.code ? el('div', { class: 'm-cr-codes' }, el('code', { text: c.code }), c.name ? el('span', { text: c.name }) : null) : null,
        el('p', { class: 'm-cr-text', text: c.text }),
        el('div', { class: 'm-cr-advice' }, el('b', { text: 'Что делать' }), el('p', { text: c.advice })));
    }));
  }

  function hardware() { temps(); crashes(); }

  function pane(p) {
    stopPaneTimer();
    clearInterval(peakTimer);
    if (p === 'music') { music(); paneTimer = setInterval(() => { if (morePane !== 'music' || tab !== 'more') { stopPaneTimer(); clearInterval(peakTimer); return; } if (!document.hidden) music(); }, 3000); peakTimer = setInterval(peaks, 250); }
    else if (p === 'games') games();
    else if (p === 'security') security();
    else if (p === 'space') space();
    else if (p === 'assistant') { hint(); setTimeout(() => $('#m-asst-text').blur(), 0); }
    else if (p === 'widget') widget();
  }

  return { pane, homeNow, hardware };
})();
