'use strict';
// Обновление программ и Windows.
// Windows: winget, Chocolatey, Scoop, Windows Update (COM API, нужны права администратора).
// Linux/macOS: apt, dnf, pacman, flatpak, snap, Homebrew (упрощённо).
const { IS_WIN, IS_MAC, run, powershell, which, CMD_EXE } = require('./exec');

function section(title, r) {
  const status = r.code === 0 || r.code === 100 ? '' : ` (код ${r.code})`;
  return `=== ${title}${status} ===\n${(r.out || '').trim() || 'нет вывода'}`;
}

async function availableManagers() {
  const names = IS_WIN ? ['winget', 'choco', 'scoop'] : IS_MAC ? ['brew'] : ['apt-get', 'dnf', 'pacman', 'flatpak', 'snap'];
  const found = {};
  for (const n of names) {
    const p = await which(n);
    if (p) found[n] = p;
  }
  return found;
}

async function checkUpdates() {
  const m = await availableManagers();
  const parts = [];
  if (m.winget) parts.push(section('winget', await run('winget', ['upgrade', '--accept-source-agreements', '--disable-interactivity'], { timeout: 300e3 })));
  if (m.choco) parts.push(section('Chocolatey', await run(m.choco, ['outdated', '-r'], { timeout: 300e3 })));
  if (m.scoop) parts.push(section('Scoop', await run(CMD_EXE, ['/c', 'scoop', 'status'], { timeout: 300e3 })));
  if (m.brew) {
    await run('brew', ['update'], { timeout: 600e3 });
    parts.push(section('Homebrew', await run('brew', ['outdated'], { timeout: 300e3 })));
  }
  if (m['apt-get']) parts.push(section('APT', await run('apt', ['list', '--upgradable'], { timeout: 120e3 })));
  if (m.dnf) parts.push(section('DNF', await run('dnf', ['-q', 'check-update'], { timeout: 600e3 })));
  if (m.pacman) parts.push(section('pacman', await run('pacman', ['-Qu'], { timeout: 600e3 })));
  if (m.flatpak) parts.push(section('Flatpak', await run('flatpak', ['remote-ls', '--updates'], { timeout: 300e3 })));
  if (m.snap) parts.push(section('Snap', await run('snap', ['refresh', '--list'], { timeout: 300e3 })));
  if (!parts.length) return 'Менеджеры пакетов не найдены. Установите winget («Установщик приложений» из Microsoft Store).';
  return parts.join('\n\n');
}

async function upgradeAll() {
  const m = await availableManagers();
  const parts = [];
  if (m.winget) {
    parts.push(section('winget', await run('winget', ['upgrade', '--all', '--silent', '--accept-package-agreements',
      '--accept-source-agreements', '--disable-interactivity'], { timeout: 3600e3 })));
  }
  if (m.choco) parts.push(section('Chocolatey', await run(m.choco, ['upgrade', 'all', '-y'], { timeout: 3600e3 })));
  if (m.scoop) parts.push(section('Scoop', await run(CMD_EXE, ['/c', 'scoop', 'update', '*'], { timeout: 3600e3 })));
  if (m.brew) parts.push(section('Homebrew', await run('brew', ['upgrade'], { timeout: 3600e3 })));
  const sudo = (args) => run('sudo', ['-n', ...args], { timeout: 3600e3 });
  if (m['apt-get']) {
    await sudo(['apt-get', 'update', '-q']);
    parts.push(section('APT', await sudo(['apt-get', '-y', '-o', 'Dpkg::Options::=--force-confold', 'upgrade'])));
  }
  if (m.dnf) parts.push(section('DNF', await sudo(['dnf', '-y', 'upgrade'])));
  if (m.pacman) parts.push(section('pacman', await sudo(['pacman', '-Syu', '--noconfirm'])));
  if (m.flatpak) parts.push(section('Flatpak', await run('flatpak', ['update', '-y', '--noninteractive'], { timeout: 3600e3 })));
  if (m.snap) parts.push(section('Snap', await sudo(['snap', 'refresh'])));
  if (!parts.length) return 'Менеджеры пакетов не найдены.';
  return parts.join('\n\n');
}

const WU_SEARCH = `
$ErrorActionPreference='Stop'
$s = New-Object -ComObject Microsoft.Update.Session
$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($r.Updates.Count -eq 0) { 'Обновлений Windows не найдено.' }
else {
  "Доступно обновлений Windows: $($r.Updates.Count)"
  foreach ($u in $r.Updates) { ' • ' + $u.Title }
}`;

const WU_INSTALL = `
$ErrorActionPreference='Stop'
$s = New-Object -ComObject Microsoft.Update.Session
$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($r.Updates.Count -eq 0) { 'Нет обновлений для установки.'; exit 0 }
$c = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $r.Updates) { if (-not $u.EulaAccepted) { $u.AcceptEula() }; [void]$c.Add($u) }
"Скачиваю обновлений: $($c.Count)…"
$d = $s.CreateUpdateDownloader(); $d.Updates = $c; [void]$d.Download()
$i = $s.CreateUpdateInstaller(); $i.Updates = $c; $res = $i.Install()
$codes = @{0='не начато';1='в процессе';2='успешно';3='с ошибками';4='ошибка';5='прервано'}
"Результат: $($codes[[int]$res.ResultCode])"
for ($k=0; $k -lt $c.Count; $k++) { ' • ' + $c.Item($k).Title + ' — ' + $codes[[int]$res.GetUpdateResult($k).ResultCode] }
if ($res.RebootRequired) { 'ТРЕБУЕТСЯ ПЕРЕЗАГРУЗКА' }`;

async function windowsUpdateCheck() {
  if (!IS_WIN) return 'Windows Update доступен только в Windows.';
  const r = await powershell(WU_SEARCH, 900e3);
  return r.code === 0 ? r.out : 'Ошибка Windows Update:\n' + r.out;
}

async function windowsUpdateInstall() {
  if (!IS_WIN) return 'Windows Update доступен только в Windows.';
  const r = await powershell(WU_INSTALL, 7200e3);
  return r.code === 0 ? r.out : 'Ошибка Windows Update (приложению нужны права администратора — установите его через установщик):\n' + r.out;
}

module.exports = { availableManagers, checkUpdates, upgradeAll, windowsUpdateCheck, windowsUpdateInstall };
