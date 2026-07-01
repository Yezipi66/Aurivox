@echo off
chcp 65001 >nul
title TTS Broker Restart

echo [1/2] 停止旧进程 后端 :9886 / 推理 :9880 ...
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0stop.ps1"

echo.
echo [2/2] 等待端口释放后重新启动 ...
timeout /t 2 /nobreak >nul

rem 静默重启，无黑窗；如需看编排日志可改用 run_start.bat
wscript "%~dp0start.vbs"

echo.
echo 已触发重启。后端就绪后浏览器会自动打开。
echo 进度: logs\startup.log / logs\backend.log / logs\inference.log
timeout /t 3 /nobreak >nul