# Проверки версии 1.7 на настоящей Windows (вызывается из e2e-windows.ps1, переменная $J — заголовок с токеном телефона).
param([hashtable]$J)
$ErrorActionPreference = 'Stop'
$B = 'http://127.0.0.1:8765'

Write-Host '=== 2е. Здоровье дисков и видеокарта ==='
$hw = Invoke-RestMethod "$B/api/hw?force=1" -Headers $J -TimeoutSec 120
$hw.disks | ForEach-Object { Write-Host "  диск: $($_.model) · $($_.media) $($_.bus) · $([math]::Round($_.size / 1GB)) ГБ · $($_.health) → $($_.level) · темп. $($_.temp) · износ $($_.wear)" }
if (-not $hw.disks -or $hw.disks.Count -lt 1 -or -not $hw.disks[0].level) { throw 'Нет данных о здоровье дисков' }
Write-Host "  видеокарт: $(@($hw.gpu.gpus).Count), счётчик кадров доступен: $($hw.gpu.fpsAvailable)"
if (-not $hw.gpu.fpsAvailable) { Write-Warning 'PresentMon не попал в установщик — счётчик кадров недоступен' }

Write-Host '=== 2ж. Автозагрузка: выключение и включение обратно ==='
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-ItemProperty $run -Name 'PCFC-E2E-Startup' -Value "`"$env:SystemRoot\System32\notepad.exe`"" -Force | Out-Null
$st = Invoke-RestMethod "$B/api/startup" -Headers $J -TimeoutSec 120
Write-Host "  в автозагрузке: $($st.items.Count)"
$item = $st.items | Where-Object { $_.name -eq 'PCFC-E2E-Startup' }
if (!$item) { throw 'Тестовая программа не найдена в автозагрузке' }
if (-not $item.enabled) { throw 'Новая программа должна быть включена' }
$appr = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
Invoke-RestMethod "$B/api/startup/set" -Method Post -Headers $J -ContentType 'application/json' -Body (@{ id = $item.id; enabled = $false } | ConvertTo-Json) | Out-Null
$v = (Get-ItemProperty $appr -Name 'PCFC-E2E-Startup').'PCFC-E2E-Startup'
Write-Host "  после выключения: $($v[0..3] -join ',')"
if (($v[0] -band 1) -ne 1) { throw 'Программа не выключилась в автозагрузке' }
if (-not (Get-ItemProperty $run -Name 'PCFC-E2E-Startup' -ErrorAction SilentlyContinue)) { throw 'Запись автозагрузки удалена — должна была только выключиться' }
$st2 = Invoke-RestMethod "$B/api/startup" -Headers $J -TimeoutSec 120
$item2 = $st2.items | Where-Object { $_.name -eq 'PCFC-E2E-Startup' }
if ($item2.enabled) { throw 'Список не показывает, что программа выключена' }
Invoke-RestMethod "$B/api/startup/set" -Method Post -Headers $J -ContentType 'application/json' -Body (@{ id = $item2.id; enabled = $true } | ConvertTo-Json) | Out-Null
$v = (Get-ItemProperty $appr -Name 'PCFC-E2E-Startup').'PCFC-E2E-Startup'
if (($v[0] -band 1) -ne 0) { throw 'Программа не включилась обратно' }
Remove-ItemProperty $run -Name 'PCFC-E2E-Startup'; Remove-ItemProperty $appr -Name 'PCFC-E2E-Startup' -ErrorAction SilentlyContinue
Write-Host '  автозагрузка: выключение и включение работают (запись не удаляется)'

Write-Host '=== 2з. Удаление выбранных файлов с телефона ==='
$fd = Join-Path $env:TEMP 'pcfc-e2e-files'
New-Item -ItemType Directory -Force $fd | Out-Null
'a' | Set-Content (Join-Path $fd 'del-me.txt'); 'b' | Set-Content (Join-Path $fd 'keep-me.txt'); 'c' | Set-Content (Join-Path $fd 'del-forever.txt')
$body = @{ paths = @((Join-Path $fd 'del-me.txt')) } | ConvertTo-Json
$r = Invoke-RestMethod "$B/api/files/delete" -Method Post -Headers $J -ContentType 'application/json' -Body $body
if (-not $r[0].ok -or (Test-Path (Join-Path $fd 'del-me.txt'))) { throw "Файл не удалён в корзину: $($r | ConvertTo-Json -Compress)" }
$body = @{ paths = @((Join-Path $fd 'del-forever.txt')); permanent = $true } | ConvertTo-Json
$r = Invoke-RestMethod "$B/api/files/delete" -Method Post -Headers $J -ContentType 'application/json' -Body $body
if (-not $r[0].ok) { throw 'Файл не удалён навсегда' }
if (!(Test-Path (Join-Path $fd 'keep-me.txt'))) { throw 'Удалён файл, который не выбирали' }
$body = @{ paths = @($env:SystemRoot, 'C:\', $env:USERPROFILE); permanent = $true } | ConvertTo-Json
$r = Invoke-RestMethod "$B/api/files/delete" -Method Post -Headers $J -ContentType 'application/json' -Body $body
if ($r | Where-Object { $_.ok }) { throw 'Системную папку разрешили удалить!' }
Remove-Item -Recurse -Force $fd
Write-Host '  удаляется только выбранное (по умолчанию — в корзину), системные папки защищены'

Write-Host '=== 2и. Сеть: интернет, устройства, отчёт за неделю ==='
Start-Sleep 6
$net = Invoke-RestMethod "$B/api/net" -Headers $J
Write-Host "  интернет: $($net.online), отклик $($net.latency) мс"
$devs = Invoke-RestMethod "$B/api/net/scan" -Method Post -Headers $J -ContentType 'application/json' -Body '{}' -TimeoutSec 120
Write-Host "  устройств в сети: $(@($devs).Count)"
if (-not (@($devs) | Where-Object { $_.vendor -eq 'этот компьютер' })) { throw 'Поиск устройств не нашёл даже этот компьютер' }
$wk = Invoke-RestMethod "$B/api/weekly" -Headers $J
if ($wk.text -notmatch 'Отчёт за неделю') { throw 'Отчёт за неделю не собрался' }
Write-Host '  отчёт за неделю собирается'

Write-Host '=== 2к. Голосовая команда: распознавание речи в установленной программе ==='
$ogg = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path 'tests\fixtures\voice-sample.ogg')))
$t0 = Get-Date
$v = Invoke-RestMethod "$B/api/test/transcribe" -Method Post -Headers $J -ContentType 'application/json' -Body (@{ audio = $ogg } | ConvertTo-Json) -TimeoutSec 900
Write-Host "  распознано за $([math]::Round(((Get-Date) - $t0).TotalSeconds)) с (с загрузкой модели), сама речь — $($v.ms) мс: «$($v.text)»"
if (-not $v.text -or $v.text.Length -lt 10) { throw 'Речь не распознана' }
$v = Invoke-RestMethod "$B/api/test/transcribe" -Method Post -Headers $J -ContentType 'application/json' -Body (@{ audio = $ogg } | ConvertTo-Json) -TimeoutSec 300
Write-Host "  повторно (модель уже загружена): $($v.ms) мс"

Write-Host '=== 2л. Доступ из интернета (туннель Cloudflare) ==='
$s = Invoke-RestMethod "$B/api/internet" -Method Post -Headers $J -ContentType 'application/json' -Body '{"enabled":true}' -TimeoutSec 300
for ($i = 0; $i -lt 60 -and $s.status -ne 'online'; $i++) { Start-Sleep 2; $s = Invoke-RestMethod "$B/api/internet" -Headers $J }
Write-Host "  туннель: $($s.status) $($s.error)"
if ($s.status -ne 'online') { throw "Туннель не поднялся: $($s.error)" }
$link = Invoke-RestMethod "$B/api/internet/link" -Method Post -Headers $J -ContentType 'application/json' -Body '{}'
$base = ($link.url -split '/#/')[0]
$code = ($link.url -split '/#/login/')[1]
$hello = $null
for ($i = 0; $i -lt 30 -and -not $hello; $i++) { try { $hello = Invoke-RestMethod "$base/api/hello" -TimeoutSec 15 } catch { Start-Sleep 3 } }
if (-not $hello) { throw 'Программа не отвечает через туннель' }
Write-Host "  через интернет отвечает: $($hello | ConvertTo-Json -Compress)"
if (-not $hello.remote -or $hello.mac) { throw 'Через интернет не должны показываться MAC и имя ПК' }
try { Invoke-RestMethod "$base/api/pair" -Method Post -ContentType 'application/json' -Body '{"code":"246810","name":"x"}' | Out-Null; throw 'PAIR-OK' } catch { if ($_.Exception.Message -eq 'PAIR-OK') { throw 'Привязка через интернет должна быть запрещена' } }
Write-Host '  привязка нового телефона через интернет запрещена'
$lg = Invoke-RestMethod "$base/api/remote-login" -Method Post -ContentType 'application/json' -Body (@{ code = $code; name = 'E2E' } | ConvertTo-Json)
$RJ = @{ Authorization = "Bearer $($lg.token)" }
$inf = Invoke-RestMethod "$base/api/info" -Headers $RJ
if (-not $inf.viaInternet) { throw 'Сервер не понял, что вход через интернет' }
try { Invoke-RestMethod "$base/api/remote-login" -Method Post -ContentType 'application/json' -Body (@{ code = $code; name = 'E2E' } | ConvertTo-Json) | Out-Null; throw 'REUSE' } catch { if ($_.Exception.Message -eq 'REUSE') { throw 'Одноразовую ссылку можно использовать повторно!' } }
Write-Host '  вход по одноразовой ссылке работает, повторно — нет'
Invoke-RestMethod "$B/api/internet" -Method Post -Headers $J -ContentType 'application/json' -Body '{"enabled":false}' | Out-Null
Write-Host 'Проверки версии 1.7 пройдены'
