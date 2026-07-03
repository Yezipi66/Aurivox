@echo off
chcp 65001 >nul
title TTS Broker Restart

echo [1/2] Stopping old processes — backend :9886 / engine :9880 ...
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0stop.ps1"

echo.
echo [2/2] Waiting for port release, then restarting ...
timeout /t 2 /nobreak >nul

rem Silent restart (no console window); use run_start.bat for visible orchestration logs
wscript "%~dp0start.vbs"

echo.
echo Restart triggered. The browser will open automatically once the backend is ready.
echo Progress: logs\startup.log / logs\backend.log / logs\inference.log
timeout /t 3 /nobreak >nul
