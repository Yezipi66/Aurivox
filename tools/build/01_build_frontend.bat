@echo off
chcp 65001 >nul
title TTS Broker · Build frontend + root node deps
setlocal

rem tools\build -> tools -> <root>
set "BUILD_DIR=%~dp0"
for %%I in ("%BUILD_DIR%..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

rem ---- pick Node: prefer bundled portable node ----
set "NPM=npm"
set "NODE=node"
if exist "%ROOT%\tools\runtime\node\npm.cmd" (
  set "NPM=%ROOT%\tools\runtime\node\npm.cmd"
  set "NODE=%ROOT%\tools\runtime\node\node.exe"
  set "PATH=%ROOT%\tools\runtime\node;%PATH%"
)
echo [build] node: %NODE%
"%NODE%" --version 2>nul || (echo [ERROR] Node not found. Run 03_fetch_runtimes.py first. & pause & exit /b 1)

rem ---- 1. root backend deps (server.js: express/cors/multer/js-yaml), prod only ----
echo.
echo [build] installing root Node deps (production) ...
call "%NPM%" install --omit=dev --no-audit --no-fund
if errorlevel 1 ( echo [ERROR] root npm install failed. & pause & exit /b 1 )

rem ---- 2. frontend build -> web\dist ----
echo.
echo [build] installing web deps + building web\dist ...
pushd "%ROOT%\web"
call "%NPM%" install --no-audit --no-fund
if errorlevel 1 ( echo [ERROR] web npm install failed. & popd & pause & exit /b 1 )
call "%NPM%" run build
if errorlevel 1 ( echo [ERROR] web build failed. & popd & pause & exit /b 1 )
popd

rem NOTE: on some Windows setups esbuild prints a harmless "Access is denied."
rem while tearing down its helper process on exit. As long as web\dist\index.html
rem exists below, the build succeeded and this message can be ignored.
if exist "%ROOT%\web\dist\index.html" (
  echo.
  echo [build] OK -^> web\dist ready, root node_modules ready.
  echo.
  pause
  endlocal
  exit /b 0
)
echo [ERROR] web\dist\index.html missing after build.
pause
endlocal
exit /b 1
