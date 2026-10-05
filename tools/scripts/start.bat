@echo off
REM =============================================================================
REM  start.bat - Windows thin shell. The body lives in tools\cli\start.js
REM
REM  NO LOGIC HERE ON PURPOSE. macOS/Linux run start.sh, which calls the SAME
REM  Node body - so the two platforms cannot drift apart.
REM
REM  ASCII-ONLY on purpose: see the note in tools\deploy\install-torch.bat.
REM =============================================================================
setlocal
set "ROOT=%~dp0..\.."

if not exist "%ROOT%\tools\cli\start.js" (
  echo [start][ERROR] body not found: %ROOT%\tools\cli\start.js
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [start][ERROR] node not found on PATH.
  echo         The body is written in Node - so Node is a prerequisite, not an extra.
  exit /b 1
)

node "%ROOT%\tools\cli\start.js" %*
exit /b %ERRORLEVEL%
