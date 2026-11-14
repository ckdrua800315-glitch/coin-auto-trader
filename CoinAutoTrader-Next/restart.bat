@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart.ps1
if errorlevel 1 (
 echo Restart failed. Read the message above.
) else (
 echo Updated paper strategy is running. Refresh the dashboard with F5.
)
pause
