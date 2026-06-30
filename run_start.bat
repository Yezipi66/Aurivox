@echo off
chcp 65001 >nul
title TTS Broker Launcher (debug)

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0start.ps1"

echo.
echo (编排已完成, 后端/推理在后台运行。关闭本窗口不影响服务。)
pause >nul
