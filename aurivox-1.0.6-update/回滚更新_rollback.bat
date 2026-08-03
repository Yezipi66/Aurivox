@echo off
setlocal
rem ============================================================
rem  Aurivox 1.0.6 update - ROLL BACK the patch (double-click).
rem  Default: git reverse-apply. To restore from a backup folder:
rem    rollback_patch.ps1 -From .patch-backup\TIMESTAMP
rem ============================================================
echo [Aurivox] Rolling back update 1.0.6 ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0rollback_patch.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" echo [Aurivox] Rollback done.
if not "%RC%"=="0" echo [Aurivox] Rollback exit code %RC% - to restore from backup run: rollback_patch.ps1 -From .patch-backup\TIMESTAMP
echo.
pause
