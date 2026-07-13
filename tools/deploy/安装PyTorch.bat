@echo off
chcp 65001 >nul
title TTS Broker · Install PyTorch / 单独安装 PyTorch
setlocal

cd /d "%~dp0"

echo ============================================================
echo   单独安装 PyTorch (CUDA 12.1)
echo   * 需先运行过 "首次部署.bat" (已创建 venv)
echo   * 默认 CUDA 12.1 版本; 如需其它版本请用命令行参数, 例如:
echo       powershell -ExecutionPolicy Bypass -File install_torch.ps1 -Cuda cu118
echo       powershell -ExecutionPolicy Bypass -File install_torch.ps1 -Cpu
echo ============================================================
echo.

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0install_torch.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [完成] PyTorch 安装结束。
) else (
  echo [提示] 安装未成功 ^(退出码 %RC%^)。请查看上面的日志后重试。
)
echo.
pause
endlocal
