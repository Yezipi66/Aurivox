@echo off
REM =============================================================================
REM  stop.bat - Windows thin shell. The body lives in tools\cli\stop.js
REM
REM  NO LOGIC HERE ON PURPOSE. macOS/Linux run stop.sh, which calls the SAME
REM  Node body - so the two platforms cannot drift apart.
REM
REM  Stops the backend and any inference engine that holds a port, then sweeps
REM  leftovers whose executable lives inside this install root.
REM
REM  See the header of tools/cli/stop.js for why this sweep exists at all.
REM
REM  This file is ASCII-only on purpose: cmd.exe reads a .bat using the console
REM  OEM code page (GBK on zh-CN Windows), and GBK-decoding UTF-8 bytes can
REM  swallow a line's trailing 0x0A - which desynchronises the parser and makes
REM  cmd execute comment fragments as commands. All Chinese lives in the body.
REM =============================================================================
setlocal
set "ROOT=%~dp0..\.."

if not exist "%ROOT%\tools\cli\stop.js" (
  echo [stop][ERROR] body not found: %ROOT%\tools\cli\stop.js
  echo         This .bat only calls it, so a missing body means the
  echo         install package is incomplete.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [stop][ERROR] node not found on PATH.
  echo         The body is written in Node - the same runtime as the backend -
  echo         so Node is a prerequisite, not an extra.
  exit /b 1
)

node "%ROOT%\tools\cli\stop.js" %*
exit /b %ERRORLEVEL%