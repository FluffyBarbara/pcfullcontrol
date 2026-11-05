'use strict';
// Обновление самого приложения из релизов GitHub (скачивает новый установщик и запускает его).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnDetached } = require('./system/exec');

function cmpVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

class AppUpdater {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async check() {
    const repo = this.ctx.config.appUpdate.repo;
    const current = this.ctx.version;
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PCFullControl' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 404) return { current, latest: null, hasUpdate: false, message: 'Релизы не найдены' };
    if (!r.ok) throw new Error(`GitHub ответил ${r.status}`);
    const rel = await r.json();
    const asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
    const latest = rel.tag_name;
    return {
      current, latest, hasUpdate: cmpVersions(latest, current) > 0 && !!asset,
      url: asset ? asset.browser_download_url : null, name: asset ? asset.name : null, notes: rel.body || '',
    };
  }

  async update() {
    const c = await this.check();
    if (!c.hasUpdate) return `Установлена последняя версия (${c.current}).`;
    if (process.platform !== 'win32') return `Доступна версия ${c.latest}, но автообновление работает только в Windows.`;
    const r = await fetch(c.url, { signal: AbortSignal.timeout(15 * 60000), headers: { 'User-Agent': 'PCFullControl' } });
    if (!r.ok) throw new Error(`Не удалось скачать установщик: HTTP ${r.status}`);
    const file = path.join(os.tmpdir(), c.name);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    // Тихая установка поверх текущей версии с последующим запуском
    setTimeout(() => {
      spawnDetached(file, ['/S', '--force-run']);
      setTimeout(() => this.ctx.quitApp(), 1500);
    }, 3000);
    return `Скачана версия ${c.latest}. Устанавливаю — приложение перезапустится через минуту.`;
  }
}

module.exports = { AppUpdater, cmpVersions };
