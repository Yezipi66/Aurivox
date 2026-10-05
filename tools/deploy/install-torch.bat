@echo off
REM =============================================================================
REM  install-torch.bat - Windows thin shell. The body lives in
REM                       tools\cli\install-torch.js
REM
REM  NO LOGIC HERE ON PURPOSE. macOS/Linux run install-torch.sh, which calls
REM  the SAME Node body - so the two platforms cannot drift apart.
REM
REM  Usage:
REM     install-torch.bat                    probe the machine, pick a build
REM     install-torch.bat --backend cpu      force CPU
REM     install-torch.bat --backend xpu      force Intel XPU
REM     install-torch.bat --backend cuda     force NVIDIA CUDA
REM     install-torch.bat --dry-run          print the decision, download nothing
REM
REM  WHY THIS FILE IS ASCII-ONLY (measured, not theory):
REM    cmd.exe reads a .bat using the console OEM code page (GBK on a zh-CN
REM    Windows). This file is UTF-8, and GBK decoding of UTF-8 bytes can
REM    swallow the trailing 0x0A as the second half of a double-byte char -
REM    which desynchronises the line parser, so cmd.exe then executes comment
REM    fragments as commands ("'xxx' is not recognized as a command").
REM    `chcp 65001` does NOT fix it: it only affects lines read AFTER it, and
REM    the byte-offset damage is already done. (Tried that first; still broke.)
REM    All user-facing Chinese lives in the Node body, where text encoding is
REM    not an issue. tools/cli/install-torch.js carries the full explanation.
REM =============================================================================
setlocal
set "ROOT=%~dp0..\.."

if not exist "%ROOT%\tools\cli\install-torch.js" (
  echo [torch][ERROR] body not found: %ROOT%\tools\cli\install-torch.js
  echo         This .bat only calls it, so a missing body means the
  echo         install package is incomplete.
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [torch][ERROR] node not found on PATH.
  echo         The body is written in Node - the same runtime as the backend
  echo         and the frontend - so Node is a prerequisite, not an extra.
  echo         https://nodejs.org  ^(pick LTS^)
  exit /b 1
)

node "%ROOT%\tools\cli\install-torch.js" %*
exit /b %ERRORLEVEL%