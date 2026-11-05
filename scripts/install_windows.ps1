# Установка PC Full Control на Windows: окружение Python, автозапуск при входе в систему, правило брандмауэра.
# Запуск: ПКМ по install_windows.bat -> «Запуск от имени администратора».
$ErrorActionPreference = "Stop"
$TaskName = "PCFullControl"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Запустите установку от имени администратора (нужно для выключения, Windows Update и брандмауэра)." -ForegroundColor Red
    exit 1
}

# 1. Python
$py = $null
foreach ($cand in @("py", "python")) {
    if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) {
    Write-Host "Python не найден. Установите Python 3.10+ с python.org (отметьте 'Add to PATH') или: winget install Python.Python.3.12" -ForegroundColor Red
    exit 1
}
Write-Host "1/5 Создаю виртуальное окружение…" -ForegroundColor Cyan
if ($py -eq "py") { & py -3 -m venv .venv } else { & python -m venv .venv }
$venvPy = Join-Path $Root ".venv\Scripts\python.exe"
$venvPyw = Join-Path $Root ".venv\Scripts\pythonw.exe"

Write-Host "2/5 Устанавливаю зависимости…" -ForegroundColor Cyan
& $venvPy -m pip install --upgrade pip -q
& $venvPy -m pip install -r requirements.txt -q

# 3. Конфиг
if (-not (Test-Path "config.yaml")) {
    Copy-Item "config.example.yaml" "config.yaml"
}
$cfg = Get-Content "config.yaml" -Raw -Encoding UTF8
if ($cfg -match 'token:\s*""') {
    Write-Host ""
    Write-Host "3/5 Настройка Telegram" -ForegroundColor Cyan
    Write-Host "Создайте бота у @BotFather в Telegram (/newbot) и вставьте токен."
    $token = Read-Host "Токен бота (Enter — пропустить)"
    if ($token) {
        $cfg = $cfg -replace 'token:\s*""', ('token: "' + $token.Trim() + '"')
        [IO.File]::WriteAllText((Join-Path $Root "config.yaml"), $cfg, (New-Object Text.UTF8Encoding $false))
    }
}

# 4. Брандмауэр — веб-панель доступна только в частных (домашних) сетях
Write-Host "4/5 Правило брандмауэра для веб-панели (только частные сети)…" -ForegroundColor Cyan
$port = 8765
if ($cfg -match 'port:\s*(\d+)') { $port = [int]$Matches[1] }
Remove-NetFirewallRule -DisplayName "PC Full Control" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "PC Full Control" -Direction Inbound -Protocol TCP -LocalPort $port `
    -Action Allow -Profile Private | Out-Null

# 5. Автозапуск через Планировщик заданий (в сеансе пользователя — чтобы работали скриншоты и звук)
Write-Host "5/5 Автозапуск при входе в Windows…" -ForegroundColor Cyan
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $venvPyw -Argument "`"$Root\run.py`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Force | Out-Null

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

Write-Host ""
Write-Host "Готово! Агент запущен и будет стартовать при каждом входе в Windows." -ForegroundColor Green
$log = Join-Path $Root "data\pcontrol.log"
if (Test-Path $log) {
    $pwdLine = Select-String -Path $log -Pattern "Пароль веб-панели" -Encoding UTF8 | Select-Object -Last 1
    $pairLine = Select-String -Path $log -Pattern "/pair" -Encoding UTF8 | Select-Object -Last 1
    $webLine = Select-String -Path $log -Pattern "Веб-панель:" -Encoding UTF8 | Select-Object -Last 1
    if ($pwdLine) { Write-Host $pwdLine.Line -ForegroundColor Yellow }
    if ($pairLine) { Write-Host $pairLine.Line -ForegroundColor Yellow }
    if ($webLine) { Write-Host $webLine.Line -ForegroundColor Yellow }
}
Write-Host "Лог: $log"
