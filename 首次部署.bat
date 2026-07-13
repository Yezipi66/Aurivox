@echo off
chcp 65001 >nul
title TTS Broker · First-time Setup / 首次部署
setlocal

cd /d "%~dp0"

echo ============================================================
echo   TTS Broker  首次部署向导
echo   本脚本将:
echo     1. 用内嵌 Python 3.11 创建虚拟环境 venv\
echo     2. 安装项目依赖(离线轮子 + PyPI, 不含 torch)
echo     3. 安装 PyTorch (CUDA 12.1)
echo     4. 引导下载模型(约 9GB, 需联网)
echo     5. 自检
echo ------------------------------------------------------------
echo   注意: 模型不随包分发, 由本向导引导你下载。
echo ============================================================
echo.

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0tools\deploy\bootstrap.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [完成] 部署成功。现在可以双击 "启动.bat" 运行。
) else (
  echo [提示] 部署未完全成功 ^(退出码 %RC%^)。请查看上面的日志, 或重跑本向导。
)
echo.
pause
endlocal
