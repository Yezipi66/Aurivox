@echo off
REM =============================================================================
REM  stop.bat - Windows entry. The body lives in tools\cli\stop.js
REM
REM  Double-click target. macOS/Linux users run tools\scripts\stop.sh, which
REM  calls the SAME Node body.
REM
REM  ASCII-ONLY on purpose: cmd.exe reads a .bat with the console OEM code page
REM  (GBK on zh-CN Windows); GBK-decoding UTF-8 bytes can swallow a line's
REM  trailing 0x0A and desynchronise the parser, so cmd runs comment fragments
REM  as commands. All Chinese lives in the Node body.
REM =============================================================================
setlocal
call "%~dp0tools\scripts\stop.bat" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo [stop] exit code %RC%
pause
exit /b %RC%
