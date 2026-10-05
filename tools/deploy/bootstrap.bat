@echo off
REM =============================================================================
REM  bootstrap.bat - Windows thin shell. The body lives in tools\deploy\bootstrap.js
REM
REM  NO LOGIC HERE ON PURPOSE. macOS/Linux run bootstrap.sh, which calls the SAME
REM  Node body - so the two platforms cannot drift apart.
REM
REM  ASCII-ONLY on purpose: cmd.exe reads a .bat with the console OEM code page
REM  (GBK on zh-CN Windows); GBK-decoding UTF-8 bytes can swallow a line's trailing
REM  0x0A and desynchronise the parser, so cmd runs comment fragments as
REM  commands. All Chinese lives in the Node body.
REM =============================================================================
setlocal
set "ROOT=%~dp0..\.."

if not exist "%ROOT%\tools\deploy\bootstrap.js" (
  echo [deploy][ERROR] body not found: %ROOT%\tools\deploy\bootstrap.js
  echo         install package is incomplete.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [deploy][ERROR] node not found on PATH.
  echo         The body is written in Node - so Node is a prerequisite, not an extra.
  echo         https://nodejs.org  ^(pick LTS^)
  exit /b 1
)

node "%ROOT%\tools\deploy\bootstrap.js" %*
exit /b %ERRORLEVEL%
