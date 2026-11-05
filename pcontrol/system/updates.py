"""Обновление программ и системы.

Windows: winget, Chocolatey, Scoop, Windows Update (через COM API, нужны права администратора).
Linux:   apt, dnf, pacman, zypper, flatpak, snap.
macOS:   Homebrew, softwareupdate.
Также: обновление самого агента (git pull + pip install).
"""
from __future__ import annotations

import sys

from ..config import BASE_DIR
from ..platform_utils import IS_MAC, IS_WINDOWS, privileged, run, run_powershell, which


def _section(title: str, code: int, out: str) -> str:
    status = "" if code in (0, 100) else f" (код {code})"
    return f"=== {title}{status} ===\n{out.strip() or 'нет вывода'}"


def available_managers() -> list[str]:
    if IS_WINDOWS:
        names = ["winget", "choco", "scoop"]
    elif IS_MAC:
        names = ["brew", "softwareupdate"]
    else:
        names = ["apt-get", "dnf", "pacman", "zypper", "flatpak", "snap"]
    return [n for n in names if which(n)]


def check_updates() -> str:
    """Список доступных обновлений программ."""
    parts = []
    m = available_managers()
    if IS_WINDOWS:
        if "winget" in m:
            parts.append(_section("winget", *run(
                ["winget", "upgrade", "--accept-source-agreements", "--disable-interactivity"], timeout=300)))
        if "choco" in m:
            parts.append(_section("Chocolatey", *run([which("choco"), "outdated", "-r"], timeout=300)))
        if "scoop" in m:
            parts.append(_section("Scoop", *run([which("scoop"), "status"], timeout=300)))
    elif IS_MAC:
        if "brew" in m:
            run(["brew", "update"], timeout=600)
            parts.append(_section("Homebrew", *run(["brew", "outdated"], timeout=300)))
        if "softwareupdate" in m:
            parts.append(_section("macOS", *run(["softwareupdate", "-l"], timeout=600)))
    else:
        if "apt-get" in m:
            run(privileged(["apt-get", "update", "-q"]), timeout=600)
            parts.append(_section("APT", *run(["apt", "list", "--upgradable"], timeout=120)))
        if "dnf" in m:
            parts.append(_section("DNF", *run(["dnf", "-q", "check-update"], timeout=600)))
        if "pacman" in m:
            cmd = ["checkupdates"] if which("checkupdates") else ["pacman", "-Qu"]
            parts.append(_section("pacman", *run(cmd, timeout=600)))
        if "zypper" in m:
            parts.append(_section("zypper", *run(["zypper", "-q", "list-updates"], timeout=600)))
        if "flatpak" in m:
            parts.append(_section("Flatpak", *run(["flatpak", "remote-ls", "--updates"], timeout=300)))
        if "snap" in m:
            parts.append(_section("Snap", *run(["snap", "refresh", "--list"], timeout=300)))
    if not parts:
        return "Менеджеры пакетов не найдены. Для Windows установите winget (App Installer из Microsoft Store)."
    return "\n\n".join(parts)


def upgrade_all() -> str:
    """Обновить все программы."""
    parts = []
    m = available_managers()
    if IS_WINDOWS:
        if "winget" in m:
            parts.append(_section("winget", *run(
                ["winget", "upgrade", "--all", "--silent", "--accept-package-agreements",
                 "--accept-source-agreements", "--disable-interactivity"], timeout=3600)))
        if "choco" in m:
            parts.append(_section("Chocolatey", *run([which("choco"), "upgrade", "all", "-y"], timeout=3600)))
        if "scoop" in m:
            parts.append(_section("Scoop", *run([which("scoop"), "update", "*"], timeout=3600)))
    elif IS_MAC:
        if "brew" in m:
            parts.append(_section("Homebrew", *run(["brew", "upgrade"], timeout=3600)))
    else:
        if "apt-get" in m:
            run(privileged(["apt-get", "update", "-q"]), timeout=600)
            parts.append(_section("APT", *run(
                privileged(["apt-get", "-y", "-o", "Dpkg::Options::=--force-confdef",
                            "-o", "Dpkg::Options::=--force-confold", "upgrade"]),
                timeout=3600)))
        if "dnf" in m:
            parts.append(_section("DNF", *run(privileged(["dnf", "-y", "upgrade"]), timeout=3600)))
        if "pacman" in m:
            parts.append(_section("pacman", *run(privileged(["pacman", "-Syu", "--noconfirm"]), timeout=3600)))
        if "zypper" in m:
            parts.append(_section("zypper", *run(privileged(["zypper", "-n", "update"]), timeout=3600)))
        if "flatpak" in m:
            parts.append(_section("Flatpak", *run(["flatpak", "update", "-y", "--noninteractive"], timeout=3600)))
        if "snap" in m:
            parts.append(_section("Snap", *run(privileged(["snap", "refresh"]), timeout=3600)))
    if not parts:
        return "Менеджеры пакетов не найдены."
    text = "\n\n".join(parts)
    if not IS_WINDOWS and "sudo" in text and "password" in text.lower():
        text += ("\n\n⚠️ Для обновления нужны права root. Запустите агент от root или разрешите "
                 "sudo без пароля для менеджера пакетов (см. README).")
    return text


_WU_SEARCH = r"""
$ErrorActionPreference='Stop'
$s = New-Object -ComObject Microsoft.Update.Session
$r = $s.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
if ($r.Updates.Count -eq 0) { 'Обновлений Windows не найдено.' }
else {
  "Доступно обновлений Windows: $($r.Updates.Count)"
  foreach ($u in $r.Updates) { ' • ' + $u.Title }
}
"""

_WU_INSTALL = r"""
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
if ($res.RebootRequired) { 'ТРЕБУЕТСЯ ПЕРЕЗАГРУЗКА' }
"""


def windows_update_check() -> str:
    if not IS_WINDOWS:
        return "Windows Update доступен только в Windows. Используйте «Проверить обновления»."
    code, out = run_powershell(_WU_SEARCH, timeout=900)
    if code != 0:
        return "Ошибка Windows Update:\n" + out
    return out


def windows_update_install() -> str:
    if not IS_WINDOWS:
        return "Windows Update доступен только в Windows."
    code, out = run_powershell(_WU_INSTALL, timeout=7200)
    if code != 0:
        out = "Ошибка Windows Update (агенту нужны права администратора):\n" + out
    return out


def self_update() -> str:
    """Обновить сам агент из git-репозитория."""
    if not (BASE_DIR / ".git").exists():
        return "Агент установлен не из git — обновите файлы вручную."
    if not which("git"):
        return "git не установлен."
    code, out = run(["git", "pull", "--ff-only"], cwd=str(BASE_DIR), timeout=300)
    text = _section("git pull", code, out)
    if code == 0:
        text += "\n\n" + _section("pip", *run(
            [sys.executable, "-m", "pip", "install", "-q", "-r", str(BASE_DIR / "requirements.txt")],
            timeout=900))
    return text
