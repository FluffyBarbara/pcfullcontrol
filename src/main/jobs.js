'use strict';
// Долгие фоновые задания (обновления) с сохранением результата в базе.
const { E } = require('./telegram-api');

class JobManager {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.db.failStaleJobs();
  }

  /** Запустить задание. Одновременно — одно задание каждого вида. Возвращает { id, isNew }. */
  start(kind, title, fn, notify = true) {
    const existing = this.ctx.db.runningJob(kind);
    if (existing) return { id: existing.id, isNew: false };
    const id = this.ctx.db.createJob(kind, title);
    this.ctx.emit('event');
    (async () => {
      let output;
      let status = 'done';
      try {
        output = (await fn()) || '';
      } catch (e) {
        output = `Ошибка: ${e.message}`;
        status = 'error';
      }
      this.ctx.db.finishJob(id, status, output);
      this.ctx.emit('event');
      if (!notify) return;
      const head = `${status === 'done' ? '✅' : '❌'} <b>${E(title)}</b> — задание #${id} завершено`;
      const text = output.trim() || '(нет вывода)';
      if (text.length <= 3000) {
        this.ctx.notifier.notify(`${head}\n<pre>${E(text)}</pre>`, { category: 'job' });
      } else {
        this.ctx.notifier.notify(`${head}\nПолный вывод — в файле.`, {
          category: 'job', document: { name: `job_${id}_${kind}.txt`, data: Buffer.from(text, 'utf8') },
        });
      }
    })();
    return { id, isNew: true };
  }
}

module.exports = { JobManager };
