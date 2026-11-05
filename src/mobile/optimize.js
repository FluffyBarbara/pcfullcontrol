'use strict';
// Очистка компьютера и удаление программ с телефона.
// Ничего не удаляется без выбора: по умолчанию все пункты сняты, перед удалением — подтверждение.
const MOptimize = (() => {
  let found = [];
  let apps = [];
  let appsLoaded = false;

  const fmt = (n) => fmtBytesM(n);
  function fmtBytesM(n) {
    if (!n) return '0 Б';
    const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
  }

  function checkRow({ title, sub, icon, right = '', data = {}, disabled = false, empty = false }) {
    const cb = el('input', { type: 'checkbox', ...data, disabled });
    return el('label', { class: 'm-check' + (disabled ? ' disabled' : '') + (empty ? ' is-empty' : '') }, cb,
      el('span', { class: 'check' }, ic('check', 14)),
      icon ? el('span', { class: 'item-ic sm' }, ic(icon, 17)) : null,
      el('span', { class: 'm-check-main' }, el('b', { text: title }), sub ? el('small', { text: sub }) : null),
      right ? el('span', { class: 'm-check-right', text: right }) : null);
  }

  // ---------------- очистка ----------------
  function selected() { return found.filter((c) => $(`#m-clean-list input[data-id="${c.id}"]`)?.checked); }

  function updateRun() {
    const sel = selected();
    const size = sel.reduce((s, c) => s + (c.size || 0), 0);
    const btn = $('#m-clean-run');
    btn.disabled = !sel.length;
    btn.replaceChildren(ic('trash', 18), sel.length ? `Очистить выбранное · ${fmt(size)}` : 'Отметьте, что очистить');
  }

  async function scan() {
    const btn = $('#m-clean-scan');
    btn.classList.add('busy');
    btn.disabled = true;
    try { found = await api('/api/clean/analyze'); } catch (e) { toast(e.message, 'err'); return; } finally { btn.classList.remove('busy'); btn.disabled = false; }
    const total = found.reduce((s, c) => s + (c.size || 0), 0);
    $('#m-clean-title').textContent = `Можно освободить до ${fmt(total)}`;
    $('#m-clean-sub').textContent = 'Отметьте нужные пункты. Без вашей отметки ничего не удаляется.';
    btn.replaceChildren(ic('search', 18), 'Найти снова');
    const list = $('#m-clean-list');
    list.replaceChildren(...found.map((c) => checkRow({
      title: c.name, sub: c.desc, icon: c.icon, data: { 'data-id': c.id },
      right: c.measurable === false ? '' : c.size ? fmt(c.size) : 'пусто', empty: !c.size && c.measurable !== false,
    })));
    list.classList.remove('hidden');
    $('#m-clean-run').classList.remove('hidden');
    updateRun();
  }

  async function run() {
    const sel = selected();
    if (!sel.length) return;
    const size = sel.reduce((s, c) => s + (c.size || 0), 0);
    const ok = await confirmSheet('Удалить выбранное?', `${sel.map((c) => c.name).join(', ')}. Примерно ${fmt(size)}. Восстановить будет нельзя.`, 'Удалить', true, 'trash');
    if (!ok) return;
    haptic(20);
    const btn = $('#m-clean-run');
    btn.disabled = true;
    btn.replaceChildren(ic('hourglass', 18), 'Очищаю…');
    try {
      const res = await api('/api/clean/run', { json: { ids: sel.map((c) => c.id) } });
      const freed = res.reduce((s, r) => s + r.freed, 0);
      toast(`Готово: освобождено ${fmt(freed)}`);
    } catch (e) { toast(e.message, 'err'); }
    scan();
  }

  // ---------------- программы ----------------
  function renderApps() {
    const q = $('#m-apps-search').value.trim().toLowerCase();
    const list = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.publisher || '').toLowerCase().includes(q));
    $('#m-apps-count').textContent = apps.length ? `Установлено: ${apps.length}${q ? ` · найдено: ${list.length}` : ''}` : 'Программы не найдены';
    $('#m-apps-list').replaceChildren(...list.slice(0, 300).map((a) => {
      const meta = [a.publisher, a.version, a.size ? fmt(a.size) : ''].filter(Boolean).join(' · ');
      const row = el('button', { class: 'item tap app-row-m', 'data-tip': a.self ? 'Сама программа PC Full Control — удаляется через «Параметры Windows»' : 'Удалить программу — вы сами выберете, что именно' },
        el('div', { class: 'item-ic' }, ic('package', 20)),
        el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: a.name }), el('div', { class: 'item-sub', text: meta || '—' })),
        a.self ? null : ic('trash', 18));
      if (!a.self) row.addEventListener('click', () => uninstallFlow(a));
      return row;
    }));
  }

  async function loadApps(force = false) {
    if (appsLoaded && !force) { renderApps(); return; }
    $('#m-apps-count').textContent = 'Читаю список программ…';
    try {
      const r = await api('/api/apps');
      if (!r.available) { $('#m-apps-count').textContent = 'Удаление программ доступно только в Windows'; return; }
      apps = r.apps;
      appsLoaded = true;
      renderApps();
    } catch (e) { $('#m-apps-count').textContent = e.message; }
  }

  async function uninstallFlow(a) {
    const go = el('button', { class: 'btn danger', disabled: true }, 'Продолжить');
    const box = el('div', { class: 'm-checks' },
      checkRow({ title: 'Запустить деинсталлятор', sub: a.hasUninstaller ? 'Окно удаления откроется на экране компьютера — пройти шаги можно через «Управление экраном»' : 'У программы нет деинсталлятора', data: { id: 'mu-run' }, disabled: !a.hasUninstaller }),
      checkRow({ title: 'Без окон (тихо)', sub: a.canQuiet ? 'Если программа поддерживает — удалится без вопросов' : 'Программа не поддерживает', data: { id: 'mu-quiet' }, disabled: true }),
      checkRow({ title: 'Найти остатки', sub: 'Папки, ярлыки и записи реестра — вы сами отметите, что удалить', data: { id: 'mu-left' } }));
    const sync = () => {
      const runOn = box.querySelector('#mu-run').checked;
      const q = box.querySelector('#mu-quiet');
      q.disabled = !runOn || !a.canQuiet;
      q.closest('.m-check').classList.toggle('disabled', q.disabled);
      if (q.disabled) q.checked = false;
      go.disabled = !runOn && !box.querySelector('#mu-left').checked;
    };
    box.addEventListener('change', sync);
    go.addEventListener('click', () => closeSheet({ run: box.querySelector('#mu-run').checked, quiet: box.querySelector('#mu-quiet').checked, left: box.querySelector('#mu-left').checked }));
    const choice = await openSheet(`Удалить «${a.name}»`, [
      el('p', { class: 'muted', text: 'Отметьте, что сделать. Без отметок ничего не произойдёт.' }), box,
      el('div', { class: 'sheet-options' }, go, el('button', { class: 'btn', onclick: () => closeSheet(null) }, 'Отмена')),
    ]);
    if (!choice) return;
    if (choice.run) {
      try {
        const r = await api(`/api/apps/${a.id}/uninstall`, { json: { quiet: choice.quiet } });
        toast(r.message, 'info');
      } catch (e) { toast(e.message, 'err'); return; }
      // Ждём окончания удаления (до 10 минут), показывая ход
      const status = el('p', { class: 'muted', text: 'Следуйте шагам деинсталлятора на экране компьютера.' });
      const waiting = openSheet(`Удаляется «${a.name}»…`, [el('div', { class: 'm-wait' }, el('div', { class: 'spinner' })), status,
        el('div', { class: 'sheet-options' }, el('button', { class: 'btn primary', onclick: () => { closeSheet('skip'); RemoteControl.open(); } }, ic('cast', 18), 'Открыть экран ПК'), el('button', { class: 'btn', onclick: () => closeSheet('skip') }, 'Не ждать'))]);
      let job = null;
      const poll = setInterval(async () => {
        try { job = await api(`/api/apps/${a.id}/job`); } catch (e) { return; }
        if (job && job.state === 'done') closeSheet('done');
      }, 2500);
      await waiting;
      clearInterval(poll);
      if (job && job.state === 'done') toast(job.removed ? `«${a.name}» удалена` : 'Деинсталлятор закрылся, программа осталась в списке', job.removed ? 'ok' : 'info');
    }
    if (choice.left) await leftovers(a);
    loadApps(true);
  }

  async function leftovers(a) {
    let items;
    try { items = await api(`/api/apps/${a.id}/leftovers`, { json: {} }); } catch (e) { toast(e.message, 'err'); return; }
    if (!items.length) { toast('Остатков не найдено', 'ok'); return; }
    const KIND = { dir: ['folder', 'Папка'], file: ['file', 'Ярлык'], reg: ['key', 'Реестр'] };
    const go = el('button', { class: 'btn danger', disabled: true }, ic('trash', 18), 'Удалить выбранное');
    const box = el('div', { class: 'm-checks scroll' }, items.map((x) => checkRow({
      title: x.path, icon: KIND[x.kind][0], data: { 'data-token': x.token },
      sub: KIND[x.kind][1] + (x.uninstallEntry ? ' · запись в списке программ' : '') + (x.size ? ' · ' + fmt(x.size) : ''),
    })));
    box.addEventListener('change', () => { go.disabled = !box.querySelector('input:checked'); });
    go.addEventListener('click', () => closeSheet([...box.querySelectorAll('input:checked')].map((c) => c.dataset.token)));
    const tokens = await openSheet(`Остатки «${a.name}»`, [
      el('p', { class: 'muted', text: 'Отметьте только то, что точно относится к этой программе. Для записей реестра сохраняется резервная копия.' }), box,
      el('div', { class: 'sheet-options' }, go, el('button', { class: 'btn', onclick: () => closeSheet(null) }, 'Отмена')),
    ]);
    if (!tokens || !tokens.length) return;
    if (!(await confirmSheet('Удалить отмеченное?', `Будет удалено: ${tokens.length}. Папки удаляются безвозвратно.`, 'Удалить', true, 'trash'))) return;
    try {
      const res = await api(`/api/apps/${a.id}/remove`, { json: { tokens } });
      const ok = res.filter((r) => r.ok).length;
      toast(`Удалено ${ok} из ${res.length}`, ok === res.length ? 'ok' : 'info');
    } catch (e) { toast(e.message, 'err'); }
  }

  $('#m-clean-scan').addEventListener('click', scan);
  $('#m-clean-run').addEventListener('click', run);
  $('#m-clean-list').addEventListener('change', updateRun);
  $('#m-apps-search').addEventListener('input', renderApps);

  return { showClean: () => {}, showApps: () => loadApps() };
})();
