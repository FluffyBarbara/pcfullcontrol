@echo off
rem PC Full Control - run in a console window (for setup and troubleshooting)
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" run.py %*
) else (
    python run.py %*
)
pause
