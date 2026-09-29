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
echo             tools\runtime\node\node.exe tools\runtime\node\node_modules\npm\bin\npm-cli.js ci
echo           (⛔ 不要用 npm.cmd：它按 PATH 推断前缀，装过全局 Node 的机器上
echo            会跳到全局 npm 去，报 ERR_REQUIRE_ESM 而看不出原因)
echo.
pause
exit /b 1
