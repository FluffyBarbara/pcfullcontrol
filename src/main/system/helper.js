'use strict';
// Фоновый помощник pcfc-helper.exe (native-win/PcfcHelper.cs): программа на переднем плане, подключение
// устройств и возврат неиспользуемой памяти Windows. Один маленький процесс вместо двух PowerShell.
// Если файла нет (запуск из исходников) — модули работают по-старому, через PowerShell.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { IS_WIN } = require('./exec');

function helperPath() {
  const list = [
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'pcfc-helper.exe'),
    path.join(__dirname, '..', '..', '..', 'build', 'bin', 'pcfc-helper.exe'),
  ].filter(Boolean);
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }) || null;
}

class Helper extends EventEmitter {
  constructor({ exe = IS_WIN ? helperPath() : null, log = () => {} } = {}) {
    super();
    this.exe = exe;
    this.log = log;
    this.proc = null;
    this.want = new Set(); // activity, usb
    this.restarts = 0;
    this.restartTimer = null;
  }

  get available() { return !!this.exe; }

  /** Включить часть помощника; процесс перезапускается с нужным набором. */
  use(part) {
    if (!this.available || this.want.has(part)) return this.available;
    this.want.add(part);
    this.restart();
    return true;
  }

  restart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.spawn(), 300); // включения в течение запуска — одним процессом
    if (this.restartTimer.unref) this.restartTimer.unref();
  }

  spawn() {
    if (this.proc) { const old = this.proc; this.proc = null; try { old.kill(); } catch (e) { /* ignore */ } }
    if (!this.want.size) return;
    let p;
    try {
      p = spawn(this.exe, [...this.want], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { this.log(`помощник не запустился: ${e.message}`); return; }
    this.proc = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
    p.stdin.on('error', () => {});
    p.on('error', (e) => { this.log(`помощник: ${e.message}`); });
    p.on('exit', () => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.restarts++ < 20) { this.restartTimer = setTimeout(() => this.spawn(), 30000); if (this.restartTimer.unref) this.restartTimer.unref(); }
    });
  }

  onLine(line) {
    if (line.startsWith('A|')) this.emit('activity', line.slice(2));
    else if (line.startsWith('U|')) {
      const rest = line.slice(2);
      if (rest.startsWith('{')) { try { this.emit('usb', JSON.parse(rest)); } catch (e) { /* ignore */ } } else if (rest.startsWith('error')) this.log(`USB: ${rest}`);
    }
  }

  /** Вернуть Windows неиспользуемую память процессов (страницы уходят в резерв и подгружаются при надобности). */
  trim(pids) {
    if (!this.proc || !pids.length) return false;
    try { this.proc.stdin.write(`trim ${pids.join(' ')}\n`); return true; } catch (e) { return false; }
  }

  stop() {
    this.want.clear();
    clearTimeout(this.restartTimer);
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.stdin.end(); p.kill(); } catch (e) { /* ignore */ } }
  }
}

module.exports = { Helper, helperPath };
