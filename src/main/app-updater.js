'use strict';
// Обновление самой программы из релизов GitHub: скачивает новый установщик и запускает тихую установку.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { powershell, psQuote } = require('./system/exec');

function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** Запущена ли программа с правами администратора (Windows). */
async function isElevated() {
  if (process.platform !== 'win32') return false;
  const r = await powershell('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', 20000);
  return /true/i.test(r.out);
}

/**
 * Запускает установщик тихо (/S) с последующим запуском программы (--force-run).
 * Через Start-Process (ShellExecute): если прав администратора нет, Windows покажет запрос UAC
 * вместо молчаливой ошибки. Возвращает { ok, pid, error }.
 */
async function launchInstaller(file, elevated) {
  const verb = elevated ? '' : ' -Verb RunAs';
  const script = `$ErrorActionPreference='Stop'
try {
  $p = Start-Process -FilePath ${psQuote(file)} -ArgumentList '/S','--force-run' -PassThru${verb}
  "ok:" + $p.Id
} catch { "error:" + $_.Exception.Message }`;
  const r = await powershell(script, 120000);
  const m = r.out.match(/ok:(\d+)/);
  if (m) return { ok: true, pid: Number(m[1]) };
  const err = (r.out.match(/error:(.*)/) || [])[1] || r.out || 'неизвестная ошибка';
  return { ok: false, error: /cancel|отмен/i.test(err) ? 'Запрос прав администратора на ПК был отклонён' : err.trim() };
}

class AppUpdater {
  constructor(ctx) {
    this.ctx = ctx;
    this.busy = false;
  }

  async check() {
    const repo = this.ctx.config.appUpdate.repo;
    const current = this.ctx.version;
    let r;
    try {
      r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PCFullControl' },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error('нет связи с GitHub');
    }
    if (r.status === 404) return { current, latest: null, hasUpdate: false, message: 'Релизы не найдены' };
    if (r.status === 403) throw new Error('GitHub временно ограничил число проверок, попробуйте через час');
    if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    const info = {
      current, latest, hasUpdate: cmpVersions(latest, current) > 0 && !!asset,
      url: asset ? asset.browser_download_url : null, name: asset ? asset.name : null,
      size: asset ? asset.size : 0, notes: rel.body || '',
    };
    this.ctx.updateInfo = info;
    return info;
  }

  /** Действие «Обновить PC Full Control»: сразу отвечает, есть ли обновление, установку ведёт в фоне. */
  async startUpdate() {
    const c = await this.check();
    if (!c.hasUpdate) {
      return c.latest ? `У вас последняя версия — ${c.current}. Обновлений нет.` : `Обновлений нет (${c.message || 'релизы не найдены'}).`;
    }
    if (process.platform !== 'win32') return `Доступна версия ${c.latest}, но автообновление работает только в Windows.`;
    if (this.busy) return `Обновление до ${c.latest} уже идёт.`;
    this.busy = true;
    this.ctx.jobs.start('app_update', `Обновление PC Full Control до ${c.latest}`, async () => {
      try {
        return await this.downloadAndInstall(c);
      } finally {
        this.busy = false;
      }
    });
    return `Найдена версия ${c.latest} (у вас ${c.current}). Скачиваю и устанавливаю — программа перезапустится через 1–2 минуты, придёт уведомление.`;
  }

  async downloadAndInstall(c) {
    const res = await fetch(c.url, { signal: AbortSignal.timeout(20 * 60000), headers: { 'User-Agent': 'PCFullControl' } });
    if (!res.ok) throw new Error(`Не удалось скачать установщик: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (c.size && data.length !== c.size) throw new Error(`Установщик скачан не полностью (${data.length} из ${c.size} байт)`);
    const file = path.join(os.tmpdir(), `PCFullControl-Setup-${c.latest}.exe`);
    fs.writeFileSync(file, data);

    const elevated = await isElevated();
    const launched = await launchInstaller(file, elevated);
    if (!launched.ok) throw new Error(`Установщик не запустился: ${launched.error}`);

    this.ctx.db.setSetting('updateInProgress', { from: c.current, to: c.latest, ts: Date.now() / 1000 });
    // Даём установщику стартовать и уведомлению уйти, затем закрываемся, чтобы файлы можно было заменить
    setTimeout(() => this.ctx.quitApp(), 5000);
    return `Установщик версии ${c.latest} запущен${elevated ? '' : ' (подтвердите запрос администратора на ПК)'}.`;
  }
}

module.exports = { AppUpdater, cmpVersions, launchInstaller, isElevated };
