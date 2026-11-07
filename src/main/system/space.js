'use strict';
// «Место на диске»: какие папки и файлы занимают больше всего и где лежат одинаковые файлы.
// Обход идёт в отдельном процессе; удаляется только то, что выбрал пользователь (по умолчанию — в корзину).
const path = require('path');

let electronMod = null;
function utility() {
  try { if (!electronMod) electronMod = require('electron'); return electronMod.utilityProcess || null; } catch (e) { return null; }
}

class SpaceScanner {
  constructor(ctx) {
    this.ctx = ctx;
    this.proc = null;
    this.status = { state: 'idle' };
    this.result = null;
    this.index = null; // путь папки → { size, files, kids }
  }

  start(root, { dups = true } = {}) {
    if (this.proc) throw new Error('Проверка уже идёт');
    const r = path.resolve(String(root || ''));
    if (!root) throw new Error('Выберите диск или папку');
    const file = path.join(__dirname, 'space-worker.js');
    const up = utility();
    let w;
    if (up) w = up.fork(file, [], { serviceName: 'PC Full Control — место на диске', stdio: 'ignore' });
    else w = require('child_process').fork(file, [], { stdio: 'ignore' });
    this.proc = w;
    this.status = { state: 'scanning', phase: 'scan', root: r, files: 0, bytes: 0, dirs: 0, started: Date.now() };
    this.ctx.emit('space', this.status);
    const onMsg = (m) => {
      if (!m) return;
      if (m.type === 'progress') { this.status = { ...this.status, ...m, state: 'scanning' }; this.ctx.emit('space', this.status); }
      if (m.type === 'done') { this.finish(m); }
      if (m.type === 'error') { this.status = { ...this.status, state: 'error', error: m.error }; this.stopProc(); this.ctx.emit('space', this.status); }
    };
    w.on('message', up ? onMsg : onMsg);
    w.on('exit', () => {
      if (this.proc === w) { this.proc = null; if (this.status.state === 'scanning') { this.status = { ...this.status, state: 'error', error: 'Проверка прервалась' }; this.ctx.emit('space', this.status); } }
    });
    w.postMessage ? w.postMessage({ type: 'scan', root: r, dups }) : w.send({ type: 'scan', root: r, dups });
    return this.status;
  }

  cancel() {
    if (!this.proc) return this.status;
    try { (this.proc.postMessage || this.proc.send).call(this.proc, { type: 'cancel' }); } catch (e) { /* ignore */ }
    setTimeout(() => this.stopProc(), 3000);
    return this.status;
  }

  stopProc() {
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
  }

  finish(m) {
    this.index = new Map();
    for (const [p, size, files, parent] of m.tree) this.index.set(p, { size, files, parent, kids: [] });
    for (const [p, n] of this.index) if (n.parent && this.index.has(n.parent)) this.index.get(n.parent).kids.push(p);
    this.result = { root: m.root, files: m.files, bytes: m.bytes, top: m.top, dups: m.dups, ms: m.ms, cancelled: m.cancelled, finished: Date.now() };
    this.status = { ...this.status, state: 'done', files: m.files, bytes: m.bytes, finished: Date.now(), cancelled: m.cancelled };
    this.stopProc();
    this.ctx.emit('space', this.status);
  }

  /** Содержимое папки для карты: подпапки по размеру + «файлы в самой папке». */
  children(dir) {
    if (!this.index) return null;
    const d = dir ? path.resolve(dir) : this.result.root;
    const n = this.index.get(d);
    if (!n) return null;
    const kids = n.kids.map((p) => ({ path: p, name: path.basename(p), size: this.index.get(p).size, dir: true })).sort((a, b) => b.size - a.size);
    const ownFiles = n.size - kids.reduce((s, k) => s + k.size, 0);
    const items = kids.slice(0, 60);
    if (ownFiles > 0) items.push({ path: d, name: 'Файлы в этой папке', size: ownFiles, dir: false, own: true });
    const rest = kids.slice(60).reduce((s, k) => s + k.size, 0);
    if (rest > 0) items.push({ path: d, name: `Ещё ${kids.length - 60} папок`, size: rest, dir: false, rest: true });
    const crumbs = [];
    for (let p = d; p && this.index.has(p); p = this.index.get(p).parent) crumbs.unshift({ path: p, name: path.basename(p) || p });
    return { path: d, size: n.size, items: items.sort((a, b) => b.size - a.size), crumbs };
  }

  view({ dir = null, topLimit = 100, dupLimit = 100 } = {}) {
    if (!this.result) return { status: this.status, result: null };
    const r = this.result;
    return {
      status: this.status,
      result: {
        root: r.root, files: r.files, bytes: r.bytes, finished: r.finished, cancelled: r.cancelled,
        top: r.top.slice(0, topLimit),
        dups: r.dups.slice(0, dupLimit), dupWasted: r.dups.reduce((s, g) => s + g.wasted, 0), dupGroups: r.dups.length,
        map: this.children(dir),
      },
    };
  }

  /** Удаление выбранного: по умолчанию — в корзину; системные папки — никогда (проверяет FileManager). */
  async remove(paths, permanent = false, source = 'local', user = '') {
    const fs = require('fs');
    const list = (Array.isArray(paths) ? paths : []).map(String).filter(Boolean).slice(0, 500);
    if (!list.length) throw new Error('Ничего не выбрано');
    const sizes = new Map();
    for (const p of list) { try { sizes.set(p, fs.statSync(p).size); } catch (e) { /* уже нет */ } }
    let trash = null;
    try { const { shell } = require('electron'); if (shell && shell.trashItem) trash = (p) => shell.trashItem(p); } catch (e) { /* вне Electron */ }
    if (!permanent && !trash) throw new Error('Корзина недоступна — удаление отменено');
    const r = await this.ctx.files.deletePaths(list, { permanent, trash, local: source === 'local' });
    const ok = r.filter((x) => x.ok).map((x) => x.path);
    this.forget(ok);
    if (ok.length) {
      const bytes = ok.reduce((s, p) => s + (sizes.get(p) || 0), 0);
      this.ctx.db.addFreed(bytes, 'место на диске');
      this.ctx.db.logCommand(source, user, 'space_delete', `${ok.length} файлов${permanent ? ' навсегда' : ' в корзину'}`, true, ok.slice(0, 5).join('; '));
    }
    return r;
  }

  /** Удалённые файлы убираем из результатов, чтобы список сразу обновился. */
  forget(paths) {
    if (!this.result) return;
    const set = new Set(paths.map((p) => path.resolve(p)));
    this.result.top = this.result.top.filter((f) => !set.has(path.resolve(f.path)));
    this.result.dups = this.result.dups.map((g) => ({ ...g, files: g.files.filter((f) => !set.has(path.resolve(f))) }))
      .filter((g) => g.files.length > 1).map((g) => ({ ...g, wasted: g.size * (g.files.length - 1) }));
  }
}

module.exports = { SpaceScanner };
