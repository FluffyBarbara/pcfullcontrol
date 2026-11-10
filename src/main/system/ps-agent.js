'use strict';
// Постоянный помощник на PowerShell: запускается один раз и отвечает на запросы (одна строка JSON
// на запрос и на ответ). Так не нужно каждый раз заново запускать PowerShell — ответы приходят за миллисекунды.
// C#-код компилируется один раз в DLL в папке данных программы.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PS_EXE, secureBinDir } = require('./exec');

class PsAgent {
  /**
   * @param {{ name: string, cs?: string, ps: string, dataDir?: string, idleMs?: number, startTimeout?: number }} o
   * ps — тело скрипта: должно читать строки JSON из stdin и для каждой писать ответ через Reply.
   */
  constructor({ name, cs = '', ps, dataDir = null, idleMs = 10 * 60 * 1000, startTimeout = 60000 }) {
    this.name = name;
    this.cs = cs;
    this.ps = ps;
    this.dataDir = dataDir;
    this.idleMs = idleMs;
    this.startTimeout = startTimeout;
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.idleTimer = null;
  }

  script(dll) {
    const load = this.cs ? `
$dll = '${dll.replace(/'/g, "''")}'
$loaded = $false
if ($dll -and (Test-Path -LiteralPath $dll)) { try { Add-Type -Path $dll; $loaded = $true } catch {} }
if (-not $loaded) {
  $src = @'
${this.cs}
'@
  if ($dll) { try { New-Item -ItemType Directory -Force -Path (Split-Path $dll) | Out-Null; Add-Type -TypeDefinition $src -OutputAssembly $dll -ReferencedAssemblies System.Drawing; Add-Type -Path $dll; $loaded = $true } catch {} }
  if (-not $loaded) { Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing }
}` : '';
    return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${load}
function Reply($id, $ok, $data) {
  $o = @{ id = $id; ok = $ok; data = $data }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 6))
  [Console]::Out.Flush()
}
${this.ps}`;
  }

  start() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.ready;
    const tag = crypto.createHash('sha1').update(this.cs || this.name).digest('hex').slice(0, 10);
    const dir = this.dataDir ? secureBinDir(this.dataDir) : os.tmpdir();
    const dll = this.cs && this.dataDir ? path.join(dir, `${this.name}-${tag}.dll`) : '';
    // Скрипт с C#-кодом длиннее предела командной строки Windows (32 767 символов) — запускаем из файла
    const script = this.script(dll);
    const file = path.join(dir, `${this.name}-${crypto.createHash('sha1').update(script).digest('hex').slice(0, 10)}.ps1`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Каждый раз записываем заново (UTF-8 с BOM — иначе Windows PowerShell 5.1 исказит кириллицу):
      // подменённый кем-то файл со старым именем не запустится
      fs.writeFileSync(file, '\ufeff' + script, 'utf8');
    } catch (e) { /* ниже — понятная ошибка запуска */ }
    const p = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    let buf = '';
    let errText = '';
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`${this.name}: не запустился`)); this.kill(); }, this.startTimeout);
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line === 'ready') { clearTimeout(timer); resolve(); continue; }
          let m;
          try { m = JSON.parse(line); } catch (e) { continue; }
          const w = this.pending.get(m.id);
          if (!w) continue;
          this.pending.delete(m.id);
          clearTimeout(w.timer);
          if (m.ok) w.resolve(m.data); else w.reject(new Error(String(m.data || 'ошибка')));
        }
      });
      p.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
      p.on('exit', () => {
        clearTimeout(timer);
        reject(new Error(`${this.name}: завершился ${errText.trim().split('\n').pop() || ''}`));
        if (this.proc === p) this.proc = null;
        for (const [, w] of this.pending) { clearTimeout(w.timer); w.reject(new Error('Помощник Windows перезапускается, повторите')); }
        this.pending.clear();
      });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  /** Запрос к помощнику: { op, ... } → данные ответа. */
  async call(op, args = {}, timeout = 15000) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.kill(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Помощник Windows не ответил')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n'); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  kill() {
    clearTimeout(this.idleTimer);
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch (e) { /* ignore */ } }
  }
}

module.exports = { PsAgent };
