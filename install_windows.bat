@echo off
rem PC Full Control - install (run as Administrator)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_windows.ps1"
pause
