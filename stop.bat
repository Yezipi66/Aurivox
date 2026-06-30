@echo off
chcp 65001 >nul
title TTS Broker Stop
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0stop.ps1"
echo.
echo 已尝试停止后端(:9886)与推理(:9880)。
pause
