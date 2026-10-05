@echo off
REM =============================================================================
REM  start.bat - Windows entry. The body lives in tools\cli\start.js
REM
REM  Double-click target. macOS/Linux users run tools\scripts\start.sh, which
REM  calls the SAME Node body.
REM
REM  ASCII-ONLY on purpose: cmd.exe reads a .bat with the console OEM code page
REM  (GBK on zh-CN Windows); GBK-decoding UTF-8 bytes can swallow a line's
REM  trailing 0x0A and desynchronise the parser, so cmd runs comment fragments
REM  as commands. All Chinese lives in the Node body.
REM =============================================================================
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%tools\cli\start.js" (
  echo [start][ERROR] body not found: %ROOT%tools\cli\start.js
  echo         install package is incomplete.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [start][ERROR] node not found on PATH.
  echo         The body is written in Node - the same runtime as the backend -
  echo         so Node is a prerequisite, not an extra.
  echo         https://nodejs.org  ^(pick LTS^)
  pause
  exit /b 1
)

node "%ROOT%tools\cli\start.js" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [start] exit code %RC%
pause
exit /b %RC%
