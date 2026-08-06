@echo off
chcp 65001 >nul
title TTS Broker - Build frontend + root node deps
setlocal

rem tools\build -> tools -> <root>
set "BUILD_DIR=%~dp0"
for %%I in ("%BUILD_DIR%..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"
if errorlevel 1 (
  echo [ERROR] Could not enter the project root:
  echo         %ROOT%
  pause
  exit /b 1
)

rem ---- use bundled portable Node and npm directly ----
set "NODE=%ROOT%\tools\runtime\node\node.exe"
set "NPM_CLI=%ROOT%\tools\runtime\node\node_modules\npm\bin\npm-cli.js"
set "PATH=%ROOT%\tools\runtime\node;%PATH%"

if not exist "%NODE%" (
  echo [ERROR] Bundled Node was not found:
  echo         %NODE%
  echo [ERROR] Run 03_fetch_runtimes.py first.
  pause
  exit /b 1
)

if not exist "%NPM_CLI%" (
  echo [ERROR] Bundled npm was not found:
  echo         %NPM_CLI%
  echo [ERROR] Run 03_fetch_runtimes.py again to restore the complete Node runtime.
  pause
  exit /b 1
)

echo [build] node:
"%NODE%" --version
if errorlevel 1 (
  echo [ERROR] Bundled Node could not start.
  pause
  exit /b 1
)

echo [build] npm:
"%NODE%" "%NPM_CLI%" --version
if errorlevel 1 (
  echo [ERROR] Bundled npm could not start.
  pause
  exit /b 1
)

rem ---- 1. root backend deps (server.js: express/cors/multer/js-yaml), prod only ----
echo.
echo [build] installing root Node deps (production) ...
"%NODE%" "%NPM_CLI%" install --omit=dev --no-audit --no-fund
if errorlevel 1 (
  echo [ERROR] root npm install failed.
  pause
  exit /b 1
)

rem ---- 2. frontend build -> web\dist ----
echo.
echo [build] installing web deps + building web\dist ...
pushd "%ROOT%\web"
if errorlevel 1 (
  echo [ERROR] Could not enter the web directory:
  echo         %ROOT%\web
  pause
  exit /b 1
)

"%NODE%" "%NPM_CLI%" install --no-audit --no-fund
if errorlevel 1 (
  echo [ERROR] web npm install failed.
  popd
  pause
  exit /b 1
)

"%NODE%" "%NPM_CLI%" run build
if errorlevel 1 (
  echo [ERROR] web build failed.
  popd
  pause
  exit /b 1
)

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
