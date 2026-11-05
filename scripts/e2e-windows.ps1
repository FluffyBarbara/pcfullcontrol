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
Start-Sleep 12  # помощник ввода запускается заранее при открытии экрана
$sw = [Diagnostics.Stopwatch]::StartNew()
Invoke-RestMethod 'http://127.0.0.1:8765/api/remote/input' -Method Post -Headers $H -ContentType 'application/json' -Body '{"type":"move","x":0.25,"y":0.5,"monitor":1}' | Out-Null
Write-Host "Первое касание обработано за $($sw.ElapsedMilliseconds) мс"
if ($sw.ElapsedMilliseconds -gt 3000) { throw 'Первое касание слишком долгое — помощник ввода не запущен заранее' }
Start-Sleep 2
Add-Type -AssemblyName System.Windows.Forms
$pos = [System.Windows.Forms.Cursor]::Position
$ex = [int]($d.width * 0.25); $ey = [int]($d.height * 0.5)
Write-Host "Курсор: $($pos.X),$($pos.Y), ожидалось около $ex,$ey"
if ([math]::Abs($pos.X - $ex) -gt 20 -or [math]::Abs($pos.Y - $ey) -gt 20) { throw 'Курсор не переместился туда, куда указал телефон' }
Invoke-RestMethod 'http://127.0.0.1:8765/api/remote/input' -Method Post -Headers $H -ContentType 'application/json' -Body '{"type":"key","keys":"shift"}' | Out-Null
Write-Host 'Удалённое управление работает'

Write-Host '=== 2в. Видео по WebRTC (до 120 кадр/с) и курсор через канал данных ==='
$pw = Join-Path $env:RUNNER_TEMP 'pw'
npm install --prefix $pw playwright-core@1.63.0 --no-audit --no-fund | Out-Host
node scripts/e2e-rtc.js (Join-Path $pw 'node_modules\playwright-core') $pair.token
if ($LASTEXITCODE -ne 0) { throw 'Трансляция экрана по WebRTC не работает' }

Write-Host '=== 2г. Оптимизация: очищается только выбранное ==='
$J = @{ Authorization = "Bearer $($pair.token)" }
$oldTmp = Join-Path $env:TEMP 'pcfc-e2e-old.tmp'
$newTmp = Join-Path $env:TEMP 'pcfc-e2e-new.tmp'
Set-Content $oldTmp ('x' * 50000); (Get-Item $oldTmp).LastWriteTime = (Get-Date).AddHours(-3)
Set-Content $newTmp 'fresh'
$an = Invoke-RestMethod 'http://127.0.0.1:8765/api/clean/analyze' -Headers $J -TimeoutSec 120
$an | ForEach-Object { Write-Host ("  {0,-38} {1,12:N0} байт  ({2} файлов)" -f $_.name, $_.size, $_.count) }
if (-not ($an | Where-Object { $_.id -eq 'user-temp' -and $_.size -ge 50000 })) { throw 'Анализ не нашёл старый временный файл' }
if (!(Test-Path $oldTmp)) { throw 'Анализ удалил файл — так нельзя' }
try { Invoke-RestMethod 'http://127.0.0.1:8765/api/clean/run' -Method Post -Headers $J -ContentType 'application/json' -Body '{"ids":[]}' | Out-Null; throw 'Очистка без выбора должна быть запрещена' } catch { if ($_.Exception.Message -like '*должна быть*') { throw } }
$rc = Invoke-RestMethod 'http://127.0.0.1:8765/api/clean/run' -Method Post -Headers $J -ContentType 'application/json' -Body '{"ids":["user-temp"]}' -TimeoutSec 300
Write-Host "Очистка TEMP: освобождено $($rc[0].freed) байт, пропущено $($rc[0].skipped)"
if (Test-Path $oldTmp) { throw 'Старый временный файл не удалён' }
if (!(Test-Path $newTmp)) { throw 'Свежий временный файл удалён — так нельзя' }

Write-Host '=== 2д. Удаление программы: деинсталлятор и остатки по выбору ==='
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PCFC-E2E-App'
$loc = 'C:\PCFC E2E App'
$data = Join-Path $env:APPDATA 'PCFC E2E App'
New-Item -ItemType Directory -Force $loc, $data | Out-Null
Set-Content (Join-Path $loc 'app.txt') 'app'; Set-Content (Join-Path $data 'settings.ini') 'cfg'
New-Item -Force 'HKCU:\Software\PCFC E2E App' | Out-Null
New-ItemProperty 'HKCU:\Software\PCFC E2E App' -Name 'Theme' -Value 'dark' -Force | Out-Null
New-Item -Force $key | Out-Null
# «Деинсталлятор» убирает только свою запись из списка программ — как многие настоящие, оставляя папки и настройки
$un = "`"$env:SystemRoot\System32\cmd.exe`" /c reg delete `"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\PCFC-E2E-App`" /f"
Set-ItemProperty $key -Name DisplayName -Value 'PCFC E2E App 1.0'
Set-ItemProperty $key -Name Publisher -Value 'PCFC Tests'
Set-ItemProperty $key -Name InstallLocation -Value $loc
Set-ItemProperty $key -Name UninstallString -Value $un
$apps = Invoke-RestMethod 'http://127.0.0.1:8765/api/apps' -Headers $J -TimeoutSec 120
Write-Host "Программ в списке: $($apps.apps.Count)"
$app = $apps.apps | Where-Object { $_.name -eq 'PCFC E2E App 1.0' }
if (!$app) { throw 'Тестовая программа не найдена в списке' }
$r = Invoke-RestMethod "http://127.0.0.1:8765/api/apps/$($app.id)/uninstall" -Method Post -Headers $J -ContentType 'application/json' -Body '{}'
Write-Host $r.message
$job = $null
for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; $job = Invoke-RestMethod "http://127.0.0.1:8765/api/apps/$($app.id)/job" -Headers $J; if ($job.state -eq 'done') { break } }
Write-Host "Ход удаления: $($job | ConvertTo-Json -Compress)"
if (-not $job.removed) { throw 'Деинсталлятор не отработал' }
if (!(Test-Path $loc) -or !(Test-Path $data)) { throw 'Остатки удалены без выбора пользователя — так нельзя' }
$left = Invoke-RestMethod "http://127.0.0.1:8765/api/apps/$($app.id)/leftovers" -Method Post -Headers $J -ContentType 'application/json' -Body '{}'
$left | ForEach-Object { Write-Host "  остаток: [$($_.kind)] $($_.path)" }
$pick = @($left | Where-Object { $_.path -eq $loc -or $_.path -eq $data -or $_.path -like '*\Software\PCFC E2E App' } | ForEach-Object { $_.token })
if ($pick.Count -lt 3) { throw "Найдены не все остатки (папка программы, данные, реестр): $($pick.Count)" }
# Удаляем только папку программы и реестр — папку данных НЕ выбираем, она должна остаться
$pick2 = @($left | Where-Object { $_.path -eq $loc -or $_.path -like '*\Software\PCFC E2E App' } | ForEach-Object { $_.token })
$body = @{ tokens = $pick2 } | ConvertTo-Json -Compress
$rm = Invoke-RestMethod "http://127.0.0.1:8765/api/apps/$($app.id)/remove" -Method Post -Headers $J -ContentType 'application/json' -Body $body
$rm | ForEach-Object { Write-Host "  удалено: $($_.path) ok=$($_.ok) $($_.backup)" }
if (Test-Path $loc) { throw 'Папка программы не удалена' }
if (Test-Path 'HKCU:\Software\PCFC E2E App') { throw 'Раздел реестра не удалён' }
if (!(Test-Path $data)) { throw 'Удалена папка, которую пользователь не выбирал' }
if (-not ($rm | Where-Object { $_.backup -and (Test-Path $_.backup) })) { throw 'Нет резервной копии реестра' }
Remove-Item -Recurse -Force $data
Write-Host 'Удаление программ работает: только выбранное, с резервной копией реестра'

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

# Следы «старых версий» для проверки уборки после обновления
$oldDir = Join-Path ${env:ProgramFiles(x86)} 'PC Full Control'
New-Item -ItemType Directory -Force (Join-Path $oldDir 'resources') | Out-Null
Set-Content (Join-Path $oldDir 'PCFullControl.exe') 'old'; Set-Content (Join-Path $oldDir 'resources\app.asar') 'old'
$dl = Join-Path $env:USERPROFILE 'Downloads'
New-Item -ItemType Directory -Force $dl | Out-Null
$oldSetup = Join-Path $dl 'PCFullControl-Setup (2).exe'
$decoy = Join-Path $dl 'OtherProgram-Setup.exe'
Set-Content $oldSetup 'old installer'; Set-Content $decoy 'not ours'
$env:PCFC_TEST_PREV_VERSION = '1.5.0'

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

Write-Host '=== 4. Уборка после обновления: старые копии и установщики программы ==='
for ($i = 0; $i -lt 30 -and ((Test-Path $oldDir) -or (Test-Path $oldSetup)); $i++) { Start-Sleep 2 }
Write-Host "Старая копия: $(Test-Path $oldDir), старый установщик: $(Test-Path $oldSetup), чужой файл: $(Test-Path $decoy)"
Get-Content $log.FullName | Select-String 'уборка' | Write-Host
if (Test-Path $oldDir) { throw 'Старая копия программы не удалена' }
if (Test-Path $oldSetup) { throw 'Старый установщик не удалён' }
if (!(Test-Path $decoy)) { throw 'Удалён чужой файл из «Загрузок» — так нельзя' }
if (!(Test-Path $exe)) { throw 'Удалена текущая программа!' }
Remove-Item $decoy -Force
Write-Host 'Уборка после обновления работает: удалено только своё'

Write-Host '=== Готово: установка, запуск и обновление внутри программы работают ==='
