# Проверка на настоящей Windows (GitHub Actions): установка, запуск, сервер для телефона
# и обновление поверх работающей программы тем же способом, что и кнопка «Обновить PC Full Control».
$ErrorActionPreference = 'Stop'
$inst = (Resolve-Path 'out\windows\PCFullControl-Setup.exe').Path

function Wait-Hello([int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    try { return Invoke-RestMethod 'http://127.0.0.1:8765/api/hello' -TimeoutSec 3 } catch { Start-Sleep 1 }
  }
  throw "Сервер для телефона не ответил за $seconds с"
}
function App-Pids { @(Get-Process PCFullControl -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }

Write-Host '=== 1. Тихая установка ==='
Start-Process $inst -ArgumentList '/S' -Wait
$task = Get-ScheduledTask -TaskName PCFullControl -ErrorAction SilentlyContinue
if (!$task) { throw 'Задача автозапуска не создана' }
$exe = $task.Actions[0].Execute.Trim('"')
Write-Host "Задача автозапуска: $exe $($task.Actions[0].Arguments) (права: $($task.Principal.RunLevel))"
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'PC Full Control*' } | ForEach-Object { Write-Host "Установлено: $($_.DisplayName) $($_.DisplayVersion) → $($_.InstallLocation)" }
if (!(Test-Path $exe)) { throw "Программа не установилась: нет $exe" }
netsh advfirewall firewall show rule name="PC Full Control"
if ($LASTEXITCODE -ne 0) { throw 'Правило брандмауэра не создано' }

Write-Host '=== 2. Запуск ==='
Start-Process $exe
$hello = Wait-Hello 90
Write-Host "Ответ: $($hello | ConvertTo-Json -Compress)"
if ($hello.app -ne 'pc-full-control') { throw 'Неожиданный ответ сервера' }
$before = App-Pids
Write-Host "Процессы до обновления: $($before -join ', ')"

Write-Host '=== 3. Обновление поверх работающей программы ==='
node -e "require('./src/main/app-updater').launchInstaller(process.argv[1], true).then((r) => { console.log(JSON.stringify(r)); if (!r.ok) process.exit(1); })" $inst
if ($LASTEXITCODE -ne 0) { throw 'Установщик не запустился' }
# Как и настоящая программа: закрываемся через 5 секунд после запуска установщика
Start-Sleep 5
$before | ForEach-Object { Stop-Process -Id $_ -ErrorAction SilentlyContinue }

# Ждём, пока установщик закончит и запустит новую копию программы
$deadline = (Get-Date).AddSeconds(240)
do {
  Start-Sleep 3
  $now = App-Pids
  $fresh = @($now | Where-Object { $before -notcontains $_ })
} while ($fresh.Count -eq 0 -and (Get-Date) -lt $deadline)
if ($fresh.Count -eq 0) { throw 'После обновления программа не запустилась снова' }
Write-Host "Новые процессы: $($fresh -join ', ')"
$hello2 = Wait-Hello 90
Write-Host "Ответ после обновления: $($hello2 | ConvertTo-Json -Compress)"

Write-Host '=== Готово: установка, запуск и обновление работают ==='
