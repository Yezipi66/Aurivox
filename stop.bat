@echo off
chcp 65001 >nul
title TTS Broker Stop
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0stop.ps1"
echo.
echo Stopped backend (:9886) and inference engine (:9880).
pause
