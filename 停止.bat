@echo off
chcp 65001 >nul
title TTS Broker · Stop / 停止

cd /d "%~dp0"

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0tools\scripts\stop.ps1"

echo.
echo 已停止后端 ^(:9886^) 与推理引擎 ^(:9880^)。
pause
