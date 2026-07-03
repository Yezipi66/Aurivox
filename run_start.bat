@echo off
chcp 65001 >nul
title TTS Broker Launcher (debug)

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start.ps1"

echo.
echo (Orchestration complete — backend and engine run in background. Closing this window won't affect them.)
pause >nul
