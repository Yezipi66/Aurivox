@echo off
title Aurivox - Deployment Wizard
setlocal enabledelayedexpansion
chcp 65001 >nul

cd /d "%~dp0"

set "ROOT=%~dp0"
set "PYEMB=%ROOT%tools\runtime\python\python.exe"
set "DEPLOY=%ROOT%tools\deploy"

echo ============================================================
echo   Aurivox  Deployment
echo   Steps: 1) show license  2) choose models
echo          3) review third-party licenses  4) confirm
echo          5) init env (venv + uv pip install) + torch
echo             + backend node deps (npm ci)
echo             + download selected models + ffmpeg + self-check
echo   Note: models AND node_modules are NOT bundled; this wizard
echo         downloads models and restores node deps via npm ci.
echo ============================================================
echo.

REM --- fail fast on non-ASCII (e.g. Chinese) install path -------------------
REM On Windows a non-ASCII path is mangled to D:\??\... when launching python
REM or ffmpeg, breaking slice / ASR / training. bootstrap.ps1 enforces this too
REM (exit 7); this is a best-effort early check for a nicer message.
echo %CD%| findstr /R /C:"[^ -~]" >nul
if not errorlevel 1 goto guard7

REM --- embedded python must exist to run the wizard -------------------------
if not exist "%PYEMB%" (
  echo [ERROR] Embedded Python not found: %PYEMB%
  echo         The distribution seems incomplete ^(tools\runtime\python missing^).
  goto end
)

REM ==========================================================================
REM  Stages 1-4: interactive wizard (license -> select -> licenses -> confirm)
REM ==========================================================================
"%PYEMB%" "%DEPLOY%\deploy_wizard.py"
set "RC=%ERRORLEVEL%"
if "%RC%"=="10" goto aborted
if not "%RC%"=="0" goto wizerror

REM ==========================================================================
REM  Stage 5: environment initialization + provisioning via bootstrap.ps1
REM  bootstrap.ps1 is the single hardened engine and owns, in order:
REM    - venv creation (health-checked / rebuilt if moved)
REM    - pip/setuptools/wheel upgrade, install uv (online)
REM    - uv pip install -r requirements.txt --no-deps (+ local wheels:
REM      jieba_fast / pyopenjtalk), with automatic pip fallback
REM    - PyTorch (CUDA 12.1) via install_torch.ps1
REM    - backend node deps via `npm ci` (node_modules is NOT bundled;
REM      restored from the shipped package-lock.json)
REM    - ffmpeg/ffprobe download   (honors the wizard's .deploy_ffmpeg.txt)
REM    - upstream model download   (honors the wizard's .deploy_models.txt,
REM      non-interactive: download_models.py --set <selected groups>)
REM    - import self-check + deployment summary
REM  The ENVIRONMENT is fixed/consistent (not selectable); only the downloads
REM  were the user's choice, already captured by the wizard sidecars above.
REM ==========================================================================
echo.
echo [deploy] initializing environment ^(venv + uv pip install + npm ci^) + provisioning ...
powershell -ExecutionPolicy Bypass -NoProfile -File "%DEPLOY%\bootstrap.ps1"
set "RC=%ERRORLEVEL%"
if "%RC%"=="7" goto guard7
if not "%RC%"=="0" goto envpartial

echo.
echo ============================================================
echo   [DONE] Deployment finished. You can now run the launcher.
echo ============================================================
goto end

:guard7
echo.
echo ============================================================
echo   [DEPLOY REFUSED] Install path contains non-English chars.
echo   On Windows a non-ASCII path such as Chinese is mangled to
echo   D:\??\... when launching python or ffmpeg, so Python cannot
echo   be found, and slice / ASR / training all fail.
echo.
echo   Fix: move the WHOLE folder to a pure-English path, e.g.
echo       D:\Aurivox
echo   then double-click this script again.
echo ============================================================
echo.
pause
endlocal
exit /b 7

:aborted
echo.
echo [CANCELLED] Deployment cancelled during the wizard. Nothing was installed.
goto end

:wizerror
echo.
echo [ERROR] Wizard exited with code %RC%. See messages above.
goto end

:envpartial
echo.
echo [NOTE] Environment init did not fully succeed ^(exit %RC%^).
echo        Fix the issue above, then re-run this wizard.
goto end

:end
echo.
pause
endlocal
