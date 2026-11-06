'use strict';
// Раздел «Музыка и звук»: что играет (обложка, исполнитель, альбом, плеер, окно), управление и микшер громкости.
const Music = (() => {
  let state = null;
  let coverKey = null;
  let coverUrl = null;
  let tickBase = null; // { pos, at, dur, playing }
  let mixerBusy = null; // имя программы, ползунок которой сейчас двигают
  let lastMixer = null;
  const fmtT = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

  async function control(app, action, value) {
    try { await api('media-control', { app, action, value }); } catch (e) { toast(e.message, 'err'); }
    setTimeout(refresh, 400);
  }

  function appChip(s) {
    return el('div', { class: 'mp-app' },
      s.icon ? el('img', { src: s.icon, alt: '' }) : ic('music', 16),
      el('b', { text: s.appName }),
      el('span', { class: 'pill sm ' + (s.playing ? 'ok' : ''), text: s.statusText || '' }));
  }

  function renderNow() {
    const box = $('#mp-now');
    const sessions = (state && state.sessions) || [];
    if (!state) { box.replaceChildren(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Загрузка…' }))); return; }
    if (!state.available) { box.replaceChildren(el('div', { class: 'card empty-card' }, ic('music', 28), el('p', { class: 'muted', text: 'Сведения о музыке доступны в Windows 10 и 11.' }))); return; }
    const s = sessions[0];
    if (!s) {
      box.replaceChildren(el('div', { class: 'card mp-empty' }, el('div', { class: 'mp-empty-ic' }, ic('music', 34)),
        el('div', {}, el('h3', { text: 'Сейчас ничего не играет' }), el('p', { class: 'muted', text: 'Запустите музыку или видео в любом плеере или браузере (Spotify, Яндекс Музыка, YouTube, VK…) — здесь появятся название, исполнитель, обложка и кнопки управления.' }))));
      $('#mp-others').replaceChildren();
      return;
    }
    const card = el('div', { class: 'mp-card' + (s.playing ? ' playing' : '') });
    if (coverUrl) card.style.setProperty('--cover', `url("${coverUrl}")`);
    const art = el('div', { class: 'mp-art' + (coverUrl ? '' : ' none') }, coverUrl ? el('img', { src: coverUrl, alt: '' }) : ic('music', 56));
    const meta = [];
    if (s.album) meta.push(el('span', {}, ic('disk', 14), s.album + (s.track ? ` · трек ${s.track}${s.tracks ? ' из ' + s.tracks : ''}` : '')));
    if (s.albumArtist && s.albumArtist !== s.artist) meta.push(el('span', {}, ic('user', 14), 'Исполнитель альбома: ' + s.albumArtist));
    const genres = (s.genres || []).length ? el('div', { class: 'mp-genres' }, s.genres.map((g) => el('span', { class: 'chip', text: g }))) : null;
    const fill = el('i', { id: 'mp-fill' });
    const bar = el('div', { class: 'mp-bar' + (s.can.seek ? ' seek' : ''), title: s.can.seek ? 'Нажмите, чтобы перемотать' : '' }, fill);
    if (s.can.seek) bar.addEventListener('click', (e) => { const r = bar.getBoundingClientRect(); control(s.app, 'seek', Math.round(((e.clientX - r.left) / r.width) * s.duration)); });
    const btn = (name, icon, title, cls = '', on = true, active = false) => el('button', { class: 'mp-btn ' + cls + (active ? ' active' : ''), disabled: !on, 'data-tip': title, onclick: () => control(s.app, name, name === 'shuffle' ? !s.shuffle : name === 'repeat' ? (s.repeat === 'None' ? 2 : s.repeat === 'List' ? 1 : 0) : null) }, ic(icon, cls === 'big' ? 26 : 20));
    const controls = el('div', { class: 'mp-controls' },
      s.can.shuffle ? btn('shuffle', 'shuffle', 'Перемешать', '', true, !!s.shuffle) : null,
      btn('prev', 'prev', 'Предыдущий трек', '', s.can.prev),
      btn('toggle', s.playing ? 'pause' : 'play', s.playing ? 'Пауза' : 'Играть', 'big', s.can.play || s.can.pause || true),
      btn('next', 'next', 'Следующий трек', '', s.can.next),
      s.can.repeat ? btn('repeat', 'repeat', s.repeat === 'Track' ? 'Повтор трека' : s.repeat === 'List' ? 'Повтор списка' : 'Повтор выключен', '', true, s.repeat && s.repeat !== 'None') : null);
    card.append(el('div', { class: 'mp-bg' }), art,
      el('div', { class: 'mp-info' },
        appChip(s),
        el('h2', { class: 'mp-title', text: s.title || 'Без названия', title: s.title }),
        el('div', { class: 'mp-artist', text: s.artist || (s.subtitle || 'Исполнитель неизвестен') }),
        meta.length ? el('div', { class: 'mp-meta' }, meta) : null,
        genres,
        s.window ? el('div', { class: 'mp-window', title: s.window }, ic('monitor', 14), el('span', { text: `Окно: «${s.window}»` })) : null,
        s.duration ? el('div', { class: 'mp-time' }, el('span', { id: 'mp-pos', text: fmtT(s.position) }), bar, el('span', { text: fmtT(s.duration) })) : null,
        controls));
    box.replaceChildren(card);
    tickBase = { pos: s.position, at: Date.now(), dur: s.duration, playing: s.playing };
    tick();
    // Другие плееры
    const others = sessions.slice(1);
    $('#mp-others').replaceChildren(...(others.length ? [el('div', { class: 'section-label mt22', text: 'Другие плееры' }),
      el('div', { class: 'grid g2' }, others.map((o) => el('div', { class: 'card mp-mini' },
        el('div', { class: 'mp-mini-ic' }, o.icon ? el('img', { src: o.icon, alt: '' }) : ic('music', 20)),
        el('div', { class: 'spacer mp-mini-text' }, el('b', { text: o.title || 'Без названия' }), el('span', { class: 'muted small', text: [o.artist, o.appName, o.statusText].filter(Boolean).join(' · ') })),
        el('button', { class: 'mp-btn', 'data-tip': 'Пауза / играть', onclick: () => control(o.app, 'toggle') }, ic(o.playing ? 'pause' : 'play', 18)),
        o.can.next ? el('button', { class: 'mp-btn', 'data-tip': 'Следующий', onclick: () => control(o.app, 'next') }, ic('next', 18)) : null)))] : []));
  }

  function tick() {
    if (!tickBase || !tickBase.dur) return;
    const pos = Math.min(tickBase.dur, tickBase.pos + (tickBase.playing ? (Date.now() - tickBase.at) / 1000 : 0));
    const f = $('#mp-fill');
    const p = $('#mp-pos');
    if (f) f.style.width = `${(pos / tickBase.dur) * 100}%`;
    if (p) p.textContent = fmtT(pos);
  }

  async function refresh() {
    let st;
    try { st = await api('media-state'); } catch (e) { if (!state) { state = { available: true, sessions: [] }; renderNow(); } return; }
    const s = st.sessions && st.sessions[0];
    const key = s && s.cover;
    if (key !== coverKey) {
      coverKey = key;
      coverUrl = key ? await api('media-cover', { key }).catch(() => null) : null;
    }
    const sig = JSON.stringify(st.sessions.map((x) => [x.app, x.title, x.artist, x.status, x.cover, x.window, x.shuffle, x.repeat, Math.round(x.position / 3)]));
    const changed = !state || sig !== state.sig;
    state = { ...st, sig };
    if (changed) renderNow();
    else if (s) tickBase = { pos: s.position, at: Date.now(), dur: s.duration, playing: s.playing };
    loadMixer();
  }

  // ---------------- микшер ----------------
  let setTimer = null;
  function setLevel(name, level) {
    clearTimeout(setTimer);
    setTimer = setTimeout(() => {
      const call = name === '*' ? api('mixer-master', { level, mute: false }) : api('mixer-set', { name, level, mute: false });
      call.catch((e) => toast(e.message, 'err'));
    }, 90);
  }

  function slider(value, name, muted) {
    const r = el('input', { type: 'range', min: '0', max: '100', value: String(value), class: 'slider mix-slider' + (muted ? ' muted' : '') });
    r.style.setProperty('--v', value + '%');
    r.addEventListener('pointerdown', () => { mixerBusy = name; });
    r.addEventListener('pointerup', () => { setTimeout(() => { mixerBusy = null; }, 800); });
    r.addEventListener('input', () => { r.style.setProperty('--v', r.value + '%'); const lbl = r.parentElement.querySelector('.mix-val'); if (lbl) lbl.textContent = r.value + '%'; setLevel(name, Number(r.value)); });
    return r;
  }

  function renderMixer(mx) {
    if (!mx.available || mx.noDevice) { $('#mixer-master').replaceChildren(); $('#mixer-list').replaceChildren(el('p', { class: 'muted', text: mx.noDevice ? 'Нет устройства вывода звука — подключите колонки или наушники.' : 'Микшер доступен в Windows.' })); return; }
    const masterRow = el('div', { class: 'mix-row master' },
      el('div', { class: 'mix-ic master' }, ic('volUp', 20)),
      el('div', { class: 'mix-name' }, el('b', { text: 'Общая громкость' }), el('span', { class: 'muted small', text: 'Колонки или наушники' })),
      slider(mx.master, '*', mx.masterMuted),
      el('span', { class: 'mix-val', text: mx.masterMuted ? 'выкл' : mx.master + '%' }),
      el('button', { class: 'mp-btn' + (mx.masterMuted ? ' active-danger' : ''), 'data-tip': mx.masterMuted ? 'Включить звук' : 'Выключить звук', onclick: async () => { await api('mixer-master', { mute: !mx.masterMuted }).catch((e) => toast(e.message, 'err')); loadMixer(true); } }, ic(mx.masterMuted ? 'mute' : 'volUp', 18)));
    $('#mixer-master').replaceChildren(masterRow);
    if (!mx.apps.length) { $('#mixer-list').replaceChildren(el('p', { class: 'muted mt6', text: 'Сейчас ни одна программа не выводит звук.' })); return; }
    $('#mixer-list').replaceChildren(...mx.apps.map((a) => {
      const peak = el('i');
      peak.style.width = Math.min(100, a.peak) + '%';
      return el('div', { class: 'mix-row' + (a.peak > 1 ? ' live' : ''), 'data-name': a.name },
        el('div', { class: 'mix-ic' }, a.icon ? el('img', { src: a.icon, alt: '' }) : ic(a.system ? 'bell' : 'music', 18)),
        el('div', { class: 'mix-name' }, el('b', { text: a.title, title: a.title }), el('div', { class: 'mix-peak' }, peak)),
        slider(a.volume, a.name, a.muted),
        el('span', { class: 'mix-val', text: a.muted ? 'выкл' : a.volume + '%' }),
        el('button', { class: 'mp-btn' + (a.muted ? ' active-danger' : ''), 'data-tip': a.muted ? 'Включить звук программы' : 'Выключить звук программы', onclick: async () => { await api('mixer-set', { name: a.name, mute: !a.muted }).catch((e) => toast(e.message, 'err')); loadMixer(true); } }, ic(a.muted ? 'mute' : 'volUp', 18)));
    }));
  }

  async function loadMixer(force = false) {
    if (mixerBusy && !force) return;
    let mx;
    try { mx = await api('mixer'); } catch (e) { return; }
    // Только уровни сигнала изменились — обновляем полоски, не пересоздавая ползунки
    const sig = JSON.stringify([mx.master, mx.masterMuted, mx.apps.map((a) => [a.name, a.volume, a.muted, a.title])]);
    if (!force && lastMixer === sig) {
      for (const a of mx.apps) {
        const row = document.querySelector(`.mix-row[data-name="${CSS.escape(a.name)}"]`);
        if (!row) continue;
        row.classList.toggle('live', a.peak > 1);
        const pk = row.querySelector('.mix-peak i');
        if (pk) pk.style.width = Math.min(100, a.peak) + '%';
      }
      return;
    }
    lastMixer = sig;
    if (!mixerBusy) renderMixer(mx);
  }

  function show() { state = null; coverKey = null; renderNow(); refresh(); }

  return { show, refresh, tick };
})();
