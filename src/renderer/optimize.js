'use strict';
// Раздел «Оптимизация»: очистка диска и удаление программ.
// Ничего не удаляется без выбора пользователя: по умолчанию все пункты сняты,
// перед удалением — окно подтверждения со списком того, что будет удалено.
const Optimize = (() => {
  let tab = 'clean';
  let found = [];       // результаты анализа
  let apps = [];
  let appsLoaded = false;

  // ---------------- очистка ----------------
  function selected() {
    return found.filter((c) => $(`#clean-list input[data-id="${c.id}"]`)?.checked);
  }

  function updateTotal() {
    const sel = selected();
    const size = sel.reduce((s, c) => s + (c.size || 0), 0);
    $('#clean-total').textContent = sel.length ? `Выбрано: ${sel.length} · ${fmtBytes(size)}` : 'Ничего не выбрано';
    $('#clean-run').disabled = !sel.length;
    $('#clean-run').replaceChildren(ic('trash', 16), sel.length ? `Очистить выбранное (${fmtBytes(size)})` : 'Очистить выбранное');
    $$('#clean-list .clean-item').forEach((row) => row.classList.toggle('on', row.querySelector('input').checked));
  }

  async function scan() {
    const btn = $('#clean-scan');
    btn.disabled = true;
    btn.replaceChildren(ic('hourglass', 17), 'Ищу…');
    $('#clean-result').classList.add('hidden');
    try {
      found = await api('clean-analyze');
    } catch (e) {
      toast(e.message, 'err');
      return;
    } finally {
      btn.disabled = false;
      btn.replaceChildren(ic('search', 17), 'Найти снова');
    }
    const total = found.reduce((s, c) => s + (c.size || 0), 0);
    $('#clean-title').textContent = `Можно освободить до ${fmtBytes(total)}`;
    $('#clean-sub').textContent = 'Отметьте, что именно удалить. Без вашей отметки ничего не удаляется.';
    $('#clean-list').replaceChildren(...found.map((c) => {
      const cb = el('input', { type: 'checkbox', 'data-id': c.id });
      cb.addEventListener('change', updateTotal);
      const size = c.measurable === false ? 'без размера' : c.size ? fmtBytes(c.size) : 'пусто';
      return el('label', { class: 'clean-item' + (!c.size && c.measurable !== false ? ' is-empty' : '') },
        cb, el('span', { class: 'check' }, ic('check', 14)),
        el('span', { class: 'item-ic' }, ic(c.icon || 'file', 18)),
        el('span', { class: 'item-main' }, el('b', { text: c.name }), el('small', { text: c.desc })),
        el('span', { class: 'clean-size', text: size }));
    }));
    $('#clean-list-card').classList.remove('hidden');
    updateTotal();
  }

  async function runClean() {
    const sel = selected();
    if (!sel.length) return;
    const size = sel.reduce((s, c) => s + (c.size || 0), 0);
    const ok = await openModal([
      el('h3', { text: 'Удалить выбранное?' }),
      el('p', { text: `Будет удалено примерно ${fmtBytes(size)}. Восстановить эти файлы будет нельзя.` }),
      el('div', { class: 'confirm-list' }, sel.map((c) => el('div', { class: 'confirm-row' }, ic(c.icon || 'file', 16), el('span', { text: c.name }), el('b', { text: c.measurable === false ? '' : fmtBytes(c.size || 0) })))),
      el('div', { class: 'row end mt' },
        el('button', { class: 'btn', onclick: () => closeModal(false), 'data-tip': 'Ничего не удалять' }, 'Отмена'),
        el('button', { class: 'btn danger', onclick: () => closeModal(true), 'data-tip': 'Удалить только перечисленное выше' }, ic('trash', 16), 'Удалить')),
    ]);
    if (!ok) return;
    const btn = $('#clean-run');
    btn.disabled = true;
    btn.replaceChildren(ic('hourglass', 16), 'Очищаю…');
    let res;
    try {
      res = await api('clean-run', { ids: sel.map((c) => c.id) });
    } catch (e) {
      toast(e.message, 'err');
      updateTotal();
      return;
    }
    const freed = res.reduce((s, r) => s + r.freed, 0);
    const box = $('#clean-result');
    box.replaceChildren(
      el('div', { class: 'clean-done' }, el('div', { class: 'clean-done-ic' }, ic('check', 26)),
        el('div', {}, el('h3', { text: `Освобождено ${fmtBytes(freed)}` }), el('p', { class: 'muted', text: 'Занятые программами и свежие файлы пропущены — их можно удалить позже.' }))),
      el('div', { class: 'confirm-list mt' }, res.map((r) => el('div', { class: 'confirm-row' },
        ic(r.error ? 'alert' : 'check', 16), el('span', { text: r.name }),
        el('b', { text: r.error ? 'ошибка' : r.id === 'dns' ? 'сброшен' : fmtBytes(r.freed) + (r.skipped ? ` · пропущено ${r.skipped}` : '') })))),
    );
    box.classList.remove('hidden');
    toast(`Очистка завершена: освобождено ${fmtBytes(freed)}`);
    scan();
  }

  // ---------------- удаление программ ----------------
  function fmtInstallDate(d) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d || '');
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
  }

  function renderApps() {
    const q = $('#apps-search').value.trim().toLowerCase();
    const list = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || (a.publisher || '').toLowerCase().includes(q));
    $('#apps-count').textContent = apps.length ? `Установлено программ: ${apps.length}${q ? ` · найдено: ${list.length}` : ''}` : 'Программы не найдены';
    $('#apps-list').replaceChildren(...list.map((a) => {
      const meta = [a.publisher, a.version ? 'версия ' + a.version : '', a.size ? fmtBytes(a.size) : '', fmtInstallDate(a.date)].filter(Boolean).join(' · ');
      const btn = el('button', { class: 'btn sm app-uninstall' + (a.self ? '' : ' danger'), disabled: a.self || (a.job && a.job.state === 'running') }, ic('trash', 15), a.job && a.job.state === 'running' ? 'Удаляется…' : 'Удалить…');
      if (a.self) btn.dataset.tip = 'PC Full Control удаляется через «Параметры Windows → Приложения»';
      btn.addEventListener('click', () => uninstallFlow(a));
      return el('div', { class: 'item' }, el('div', { class: 'item-ic' }, ic('package', 18)),
        el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: a.name }), el('div', { class: 'item-sub', text: meta || '—' })), btn);
    }));
  }

  async function loadApps(force = false) {
    if (appsLoaded && !force) { renderApps(); return; }
    $('#apps-count').textContent = 'Читаю список программ…';
    try {
      const r = await api('apps-list');
      if (!r.available) { $('#apps-count').textContent = 'Удаление программ доступно только в Windows'; apps = []; renderApps(); return; }
      apps = r.apps;
      appsLoaded = true;
      renderApps();
    } catch (e) { $('#apps-count').textContent = 'Не удалось получить список: ' + e.message; }
  }

  function option(id, title, sub, disabled = false) {
    const cb = el('input', { type: 'checkbox', id, disabled });
    return el('label', { class: 'opt-row' + (disabled ? ' disabled' : '') }, cb, el('span', { class: 'check' }, ic('check', 14)),
      el('span', { class: 'item-main' }, el('b', { text: title }), el('small', { text: sub })));
  }

  async function uninstallFlow(a) {
    // Шаг 1: что сделать — всё по выбору, по умолчанию ничего не отмечено
    const go = el('button', { class: 'btn danger', disabled: true, 'data-tip': 'Выполнить отмеченные шаги' }, 'Продолжить');
    const body = el('div', { class: 'opt-list' },
      option('u-run', 'Запустить деинсталлятор программы', a.hasUninstaller ? 'Откроется обычное окно удаления этой программы на экране компьютера' : 'У этой программы нет деинсталлятора', !a.hasUninstaller),
      option('u-quiet', 'Удалить без окон (тихо)', a.canQuiet ? 'Только если программа это поддерживает. Её настройки удалятся без вопросов' : 'Программа не поддерживает тихое удаление', !a.canQuiet),
      option('u-left', 'Найти остатки после удаления', 'Папки, ярлыки и записи в реестре. Вы увидите список и сами отметите, что удалить'));
    const sync = () => {
      const run = $('#u-run', body).checked;
      $('#u-quiet', body).disabled = !run || !a.canQuiet;
      if (!run) $('#u-quiet', body).checked = false;
      go.disabled = !run && !$('#u-left', body).checked;
    };
    body.addEventListener('change', sync);
    sync();
    go.addEventListener('click', () => closeModal({ run: $('#u-run', body).checked, quiet: $('#u-quiet', body).checked, left: $('#u-left', body).checked }));
    const choice = await openModal([
      el('h3', { text: `Удаление «${a.name}»` }),
      el('p', { class: 'muted', text: 'Отметьте, что нужно сделать. Без отметок ничего не произойдёт.' }),
      body,
      el('div', { class: 'row end mt' }, el('button', { class: 'btn', onclick: () => closeModal(null) }, 'Отмена'), go),
    ]);
    if (!choice) return;

    if (choice.run) {
      try {
        const r = await api('apps-uninstall', { id: a.id, quiet: choice.quiet });
        toast(r.message, 'info');
      } catch (e) { toast(e.message, 'err'); return; }
      const status = el('p', { class: 'muted', text: 'Следуйте шагам деинсталлятора на экране. Это окно закроется само, когда удаление закончится.' });
      const waitBox = [el('div', { class: 'wait-hero' }, el('div', { class: 'spinner' }), el('h3', { text: `Удаляется «${a.name}»…` })), status,
        el('div', { class: 'row end mt' }, el('button', { class: 'btn', onclick: () => closeModal('skip') }, 'Не ждать'))];
      const waiting = openModal(waitBox);
      let job = null;
      const poll = setInterval(async () => {
        try { job = await api('apps-job', { id: a.id }); } catch (e) { return; }
        if (job && job.state === 'done') closeModal('done');
      }, 2000);
      await waiting;
      clearInterval(poll);
      if (job && job.state === 'done') {
        if (job.removed) toast(`«${a.name}» удалена`);
        else if (job.error) toast('Деинсталлятор не запустился: ' + job.error, 'err');
        else toast('Деинсталлятор закрылся, но программа осталась в списке — возможно, удаление отменили', 'info');
      }
    }
    if (choice.left) await leftoversFlow(a);
    loadApps(true);
  }

  async function leftoversFlow(a) {
    let items;
    try { items = await api('apps-leftovers', { id: a.id }); } catch (e) { toast(e.message, 'err'); return; }
    if (!items.length) {
      await openModal([el('h3', { text: 'Остатков не найдено' }), el('p', { text: `После «${a.name}» не осталось папок, ярлыков и записей в реестре.` }),
        el('div', { class: 'row end mt' }, el('button', { class: 'btn primary', onclick: () => closeModal() }, 'Понятно'))]);
      return;
    }
    const KIND = { dir: ['folder', 'Папка'], file: ['file', 'Ярлык'], reg: ['key', 'Реестр'] };
    const go = el('button', { class: 'btn danger', disabled: true }, ic('trash', 16), 'Удалить выбранное');
    const list = el('div', { class: 'opt-list scroll' }, items.map((x) => {
      const [icon, label] = KIND[x.kind];
      const cb = el('input', { type: 'checkbox', 'data-token': x.token });
      return el('label', { class: 'opt-row' }, cb, el('span', { class: 'check' }, ic('check', 14)), el('span', { class: 'item-ic sm' }, ic(icon, 16)),
        el('span', { class: 'item-main' }, el('b', { class: 'mono-path', text: x.path }),
          el('small', { text: `${label}${x.uninstallEntry ? ' · запись в списке установленных программ' : ''}${x.size ? ' · ' + fmtBytes(x.size) : ''}` })));
    }));
    list.addEventListener('change', () => { go.disabled = !list.querySelector('input:checked'); });
    go.addEventListener('click', () => closeModal([...list.querySelectorAll('input:checked')].map((c) => c.dataset.token)));
    const tokens = await openModal([
      el('h3', { text: `Остатки «${a.name}»` }),
      el('p', { class: 'muted', text: 'Проверьте пути и отметьте только то, что точно относится к этой программе. Перед удалением записей реестра сохраняется резервная копия.' }),
      list,
      el('div', { class: 'row end mt' }, el('button', { class: 'btn', onclick: () => closeModal(null) }, 'Отмена'), go),
    ], 'wide');
    if (!tokens || !tokens.length) return;
    if (!(await confirmModal('Удалить отмеченное?', `Будет удалено: ${tokens.length}. Папки удаляются безвозвратно, разделы реестра — с резервной копией в папке данных программы.`, 'Удалить'))) return;
    try {
      const res = await api('apps-remove-leftovers', { id: a.id, tokens });
      const ok = res.filter((r) => r.ok).length;
      const failed = res.filter((r) => !r.ok);
      toast(`Удалено ${ok} из ${res.length}` + (failed.length ? ` · не удалось: ${failed.map((f) => f.error).join('; ')}` : ''), failed.length ? 'info' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------------- общее ----------------
  function setTab(t) {
    tab = t;
    $$('#opt-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#opt-clean').classList.toggle('hidden', t !== 'clean');
    $('#opt-apps').classList.toggle('hidden', t !== 'apps');
    $('#opt-startup').classList.toggle('hidden', t !== 'startup');
    if (t === 'apps') loadApps();
    if (t === 'startup') Extras.loadStartup();
  }

  $$('#opt-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#clean-scan').addEventListener('click', scan);
  $('#clean-run').addEventListener('click', runClean);
  $('#clean-all').addEventListener('click', () => { $$('#clean-list input').forEach((c) => { c.checked = true; }); updateTotal(); });
  $('#clean-none').addEventListener('click', () => { $$('#clean-list input').forEach((c) => { c.checked = false; }); updateTotal(); });
  $('#apps-search').addEventListener('input', renderApps);
  $('#apps-refresh').addEventListener('click', () => loadApps(true));

  return { show: () => setTab(tab) };
})();
