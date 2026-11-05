# Удаление автозапуска и правила брандмауэра PC Full Control. Файлы проекта и база данных не удаляются.
$TaskName = "PCFullControl"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "PC Full Control" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*run.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "Автозапуск PC Full Control удалён. Папку проекта (и data\ с базой) можно удалить вручную." -ForegroundColor Green
