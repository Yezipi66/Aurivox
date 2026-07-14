@echo off
title TTS Broker - Launcher

cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" goto novenv

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0tools\scripts\start.ps1"
set "RC=%ERRORLEVEL%"

if "%RC%"=="7" goto guard7

echo.
echo Startup done - backend and inference engine run in the background;
echo closing this window will not stop them.
timeout /t 3 /nobreak >nul
goto :eof

:novenv
echo [ERROR] venv\ not found.
echo         Run the first-time deployment script first.
echo.
pause
exit /b 1

:guard7
echo.
echo ============================================================
echo   [START REFUSED] Install path contains non-English chars.
echo   A non-ASCII path such as Chinese breaks python/ffmpeg
echo   process launching on Windows. Move the WHOLE folder to a
echo   pure-English path, e.g.
echo       D:\TTS-Broker
echo ============================================================
echo.
pause
exit /b 7
