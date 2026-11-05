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
$env:PCFC_TEST_PAIR_CODE = '246810'
Start-Process $exe
$hello = Wait-Hello 90
Write-Host "Ответ: $($hello | ConvertTo-Json -Compress)"
if ($hello.app -ne 'pc-full-control') { throw 'Неожиданный ответ сервера' }
$before = App-Pids
Write-Host "Процессы до обновления: $($before -join ', ')"

Write-Host '=== 2б. Удалённое управление (кадр экрана и мышь) ==='
$pair = Invoke-RestMethod 'http://127.0.0.1:8765/api/pair' -Method Post -ContentType 'application/json' -Body '{"code":"246810","name":"CI","platform":"android"}'
$H = @{ Authorization = "Bearer $($pair.token)" }
$rinfo = Invoke-RestMethod 'http://127.0.0.1:8765/api/remote/info' -Headers $H
Write-Host "Экраны: $($rinfo | ConvertTo-Json -Compress -Depth 4)"
$frame = Invoke-WebRequest 'http://127.0.0.1:8765/api/remote/frame?w=960&q=50' -Headers $H
Write-Host "Кадр: $($frame.RawContentLength) байт, курсор: $($frame.Headers['X-Cursor'])"
if ($frame.RawContentLength -lt 1000) { throw 'Кадр экрана слишком маленький' }
$d = $rinfo.displays | Where-Object { $_.primary } | Select-Object -First 1
Invoke-RestMethod 'http://127.0.0.1:8765/api/remote/input' -Method Post -Headers $H -ContentType 'application/json' -Body '{"type":"move","x":0.25,"y":0.5,"monitor":1}' | Out-Null
Start-Sleep 2
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
$ex = [int]($d.width * 0.25); $ey = [int]($d.height * 0.5)
Write-Host "Курсор: $($pos.X),$($pos.Y), ожидалось около $ex,$ey"
if ([math]::Abs($pos.X - $ex) -gt 20 -or [math]::Abs($pos.Y - $ey) -gt 20) { throw 'Курсор не переместился туда, куда указал телефон' }
Invoke-RestMethod 'http://127.0.0.1:8765/api/remote/input' -Method Post -Headers $H -ContentType 'application/json' -Body '{"type":"key","keys":"shift"}' | Out-Null
Write-Host 'Удалённое управление работает'

Write-Host '=== 3. Обновление встроенным механизмом (как кнопка «Установить обновление») ==='
$res = Join-Path (Split-Path $exe) 'resources\app-update.yml'
if (!(Test-Path $res)) { throw 'В установленной программе нет app-update.yml — обновление не найдёт релизы' }
Get-Content $res | Write-Host
$before | ForEach-Object { Stop-Process -Id $_ -ErrorAction SilentlyContinue }
Start-Sleep 3

# «Новая версия» 9.9.9 на локальном сервере обновлений (тот же установщик, та же контрольная сумма)
$feed = Join-Path $env:RUNNER_TEMP 'feed'
New-Item -ItemType Directory -Force $feed | Out-Null
Copy-Item $inst $feed
$yml = (Get-Content 'out\windows\latest.yml' -Raw) -replace '(?m)^version: .*$', 'version: 9.9.9'
Set-Content -Path (Join-Path $feed 'latest.yml') -Value $yml -Encoding utf8
Write-Host $yml
$server = Start-Process node -ArgumentList @('scripts/e2e-feed-server.js', $feed) -PassThru -NoNewWindow
Start-Sleep 2

$env:PCFC_UPDATE_FEED = 'http://127.0.0.1:9999/'
$env:PCFC_UPDATE_AUTO = '1'
Start-Process $exe
$null = Wait-Hello 90
$running = App-Pids
Write-Host "Запущено с автообновлением: $($running -join ', ')"

# Программа сама скачивает «обновление», закрывается, установщик ставит его и запускает программу снова
$deadline = (Get-Date).AddSeconds(300)
do {
  Start-Sleep 3
  $fresh = @(App-Pids | Where-Object { $running -notcontains $_ })
} while ($fresh.Count -eq 0 -and (Get-Date) -lt $deadline)

$log = Get-ChildItem -Path $env:APPDATA -Filter update.log -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($log) { Write-Host "--- $($log.FullName) ---"; Get-Content $log.FullName | Write-Host }
if ($fresh.Count -eq 0) { throw 'После обновления программа не открылась снова' }
Write-Host "Новые процессы после обновления: $($fresh -join ', ')"
$hello2 = Wait-Hello 90
Write-Host "Ответ после обновления: $($hello2 | ConvertTo-Json -Compress)"
if (!$log -or -not (Select-String -Path $log.FullName -Pattern 'quitAndInstall|Install:' -Quiet)) { throw 'В журнале обновления нет установки' }
Stop-Process -Id $server.Id -ErrorAction SilentlyContinue

Write-Host '=== Готово: установка, запуск и обновление внутри программы работают ==='
