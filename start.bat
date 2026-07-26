@echo off
title TTS Broker - Launcher

cd /d "%~dp0"

if not exist "venv\Scripts\python.exe" goto novenv
if not exist "node_modules\" goto nonode

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0tools\scripts\start.ps1"
set "RC=%ERRORLEVEL%"

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

:nonode
echo [ERROR] node_modules\ not found.
echo         Backend node dependencies are not installed. They are NOT bundled
echo         in the release and are restored by the deployment wizard via
echo         `npm ci`. Re-run the first-time deployment script (deploy.bat),
echo         or restore them manually from the project root:
echo             tools\runtime\node\npm.cmd ci
echo.
pause
exit /b 1
