@echo off
title TTS Broker - First-time Setup
setlocal

cd /d "%~dp0"

echo ============================================================
echo   TTS Broker  First-time Deployment
echo   This script will:
echo     1. create venv\ using the embedded Python 3.11
echo     2. install project deps (offline wheels + PyPI, no torch)
echo     3. install PyTorch (CUDA 12.1)
echo     4. guide you to download the models (~9GB, needs internet)
echo     5. self-check
echo ------------------------------------------------------------
echo   Note: models are NOT bundled; this wizard downloads them.
echo ============================================================
echo.

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0tools\deploy\bootstrap.ps1"
set "RC=%ERRORLEVEL%"

if "%RC%"=="7" goto guard7
if "%RC%"=="0" goto ok
goto partial

:guard7
echo.
echo ============================================================
echo   [DEPLOY REFUSED] Install path contains non-English chars.
echo   On Windows a non-ASCII path such as Chinese is mangled to
echo   D:\??\... when launching python or ffmpeg, so Python cannot
echo   be found, and slice / ASR / training all fail.
echo.
echo   Fix: move the WHOLE folder to a pure-English path, e.g.
echo       D:\TTS-Broker
echo   then double-click this script again.
echo ============================================================
echo.
pause
endlocal
exit /b 7

:ok
echo.
echo [DONE] Deployment succeeded. You can now run the launcher.
goto end

:partial
echo.
echo [NOTE] Deployment did not fully succeed. Exit code %RC%.
echo        See the log above, or re-run this wizard.
goto end

:end
echo.
pause
endlocal
