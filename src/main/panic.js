'use strict';
// «Тревожная кнопка»: одним нажатием с телефона или из Telegram —
// 1) фото с веб-камеры того, кто сейчас за компьютером; 2) выключить микрофон; 3) отключить веб-камеры;
// 4) заблокировать компьютер. Всё обратимо: «Снять тревогу» возвращает микрофон и камеры как было.
const { IS_WIN, powershell } = require('./system/exec');
const { webcamPhoto } = require('./system/screen');
const power = require('./system/power');
const { E } = require('./telegram-api');

class PanicMode {
  constructor(ctx) {
    this.ctx = ctx;
    this.busy = false;
  }

  state() {
    const st = this.ctx.db.getSetting('panicState') || null;
    return st ? { active: true, ...st } : { active: false };
  }

  async trigger(by = '') {
    if (this.busy) throw new Error('Тревожная кнопка уже срабатывает');
    this.busy = true;
    const steps = [];
    const prev = this.ctx.db.getSetting('panicState');
    const st = { since: Date.now() / 1000, by, micWasMuted: prev ? prev.micWasMuted : null, cameras: prev ? prev.cameras || [] : [], steps };
    let photo = null;
    try {
      // 1. Фото — до отключения камеры
      try { photo = await webcamPhoto(); steps.push('📸 сделано фото с веб-камеры'); } catch (e) { steps.push(`📸 фото не получилось: ${e.message}`); }
      // 2. Микрофон
      try {
        const was = await this.ctx.media.setMicMute(true);
        if (st.micWasMuted == null) st.micWasMuted = was;
        steps.push('🎙 микрофон выключен');
      } catch (e) { steps.push(`🎙 микрофон: ${e.message}`); }
      // 3. Камеры (только те, что были включены, — их и вернём)
      if (IS_WIN) {
        const r = await powershell(`$d = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.Class -in 'Camera','Image' -and $_.Status -eq 'OK' })
$ok = @(); foreach ($x in $d) { try { Disable-PnpDevice -InstanceId $x.InstanceId -Confirm:$false -ErrorAction Stop; $ok += $x.InstanceId } catch {} }
ConvertTo-Json -InputObject @($ok) -Compress`, 60000);
        let ids = [];
        try { ids = JSON.parse(r.out || '[]'); } catch (e) { ids = []; }
        st.cameras = [...new Set([...(st.cameras || []), ...ids])];
        steps.push(ids.length ? `📷 веб-камер отключено: ${ids.length}` : '📷 включённых веб-камер нет');
      }
      // 4. Блокировка
      try { await power.lock(); steps.push('🔒 компьютер заблокирован'); } catch (e) { steps.push(`🔒 блокировка: ${e.message}`); }
    } finally {
      this.busy = false;
    }
    this.ctx.db.setSetting('panicState', st);
    this.ctx.notifier.notify(`🚨 <b>Тревожная кнопка</b>${by ? ` — нажал(а) ${E(by)}` : ''}\n${steps.map((s) => '• ' + E(s)).join('\n')}\n\nСнять тревогу: /panic_off или кнопка в приложении.`,
      { category: 'security', level: 'critical', photo });
    this.ctx.emit('event');
    return this.state();
  }

  async release(by = '') {
    const st = this.ctx.db.getSetting('panicState');
    if (!st) return { active: false };
    const steps = [];
    if (st.micWasMuted === false) {
      try { await this.ctx.media.setMicMute(false); steps.push('🎙 микрофон включён'); } catch (e) { steps.push(`🎙 микрофон: ${e.message}`); }
    }
    if (IS_WIN && st.cameras && st.cameras.length) {
      const list = st.cameras.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(',');
      const r = await powershell(`$n = 0; foreach ($id in @(${list})) { try { Enable-PnpDevice -InstanceId $id -Confirm:$false -ErrorAction Stop; $n++ } catch {} }; $n`, 60000);
      steps.push(`📷 веб-камер включено: ${parseInt(r.out, 10) || 0}`);
    }
    this.ctx.db.setSetting('panicState', null);
    this.ctx.notifier.notify(`✅ <b>Тревога снята</b>${by ? ` — ${E(by)}` : ''}\n${steps.map((s) => '• ' + E(s)).join('\n') || 'Микрофон и камеры как были.'}`, { category: 'security' });
    this.ctx.emit('event');
    return { active: false, steps };
  }
}

module.exports = { PanicMode };
