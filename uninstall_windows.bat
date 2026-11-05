@echo off
rem PC Full Control - remove autostart (run as Administrator)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall_windows.ps1"
pause
