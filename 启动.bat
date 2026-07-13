@echo off
chcp 65001 >nul
title TTS Broker · Launcher / 启动

cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" (
  echo [错误] 未检测到虚拟环境 venv\ 。
  echo         请先双击运行 "首次部署.bat" 完成部署。
  echo.
  pause
  exit /b 1
)

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0tools\scripts\start.ps1"

echo.
echo (启动流程结束 — 后端与推理引擎在后台运行, 关闭本窗口不影响它们。)
timeout /t 3 /nobreak >nul
