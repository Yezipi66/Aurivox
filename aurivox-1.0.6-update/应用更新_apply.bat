@echo off
setlocal
rem ============================================================
rem  Aurivox 1.0.6 update - apply the patch (double-click).
rem  Calls apply_patch.ps1 in the same folder; auto-detects repo
rem  root and ASKS before applying.
rem ============================================================
echo [Aurivox] Applying update 1.0.6 - streaming / concurrency / residency ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0apply_patch.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" echo [Aurivox] Finished. You can close this window.
if not "%RC%"=="0" echo [Aurivox] Exit code %RC% - if the pre-check failed, nothing was changed.
echo.
pause
