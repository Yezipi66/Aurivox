@echo off
chcp 65001 >nul
title TTS Broker · Build wheelhouse (compile-needing wheels)
rem No delayed expansion here: vcvars64.bat can contain '!' and misbehave under it.
setlocal

rem ============================================================
rem  02_make_wheelhouse.bat
rem  Build cp311 wheels for packages that have NO prebuilt PyPI
rem  wheel (need a C/C++ compiler) into tools\wheels\ , so end
rem  users can install them offline WITHOUT a compiler.
rem
rem  Requires: Visual Studio 2026 Build Tools (VC x64) + CMake.
rem  Run this on YOUR machine (the one with the toolchain).
rem ============================================================

rem tools\build -> tools -> <root>
set "BUILD_DIR=%~dp0"
for %%I in ("%BUILD_DIR%..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

set "WHEELS=%ROOT%\tools\wheels"
if not exist "%WHEELS%" mkdir "%WHEELS%"

rem Clear any stale wheels (old versions / stray deps from a previous run) so the
rem wheelhouse always matches the current pins below. README.txt is preserved.
del /q "%WHEELS%\*.whl" >nul 2>nul

rem ---- packages that typically need compilation on Windows/cp311 ----
rem   (everything else has ready PyPI wheels and installs online at deploy time)
rem   Versions MUST match requirements.txt (jieba_fast==0.53, pyopenjtalk==0.4.1).
set "WHEEL_PKGS=jieba_fast==0.53 pyopenjtalk==0.4.1"

rem ---- 1. locate & enter the VC x64 build environment ----
rem  IMPORTANT (cmd parser gotcha): a value containing "(x86)" expands a bare
rem  ")" that closes an enclosing if(...)/for(...) block at PARSE time, throwing
rem  "\Microsoft was unexpected at this time" even for branches that never run.
rem  So we AVOID %ProgramFiles(x86)% and use ONLY top-level single-line ifs with
rem  fully-quoted literals (a ")" inside quotes on a single command line is safe),
rem  and a goto-based error path (never echo a paren path inside a block).
set "VCVARS="
set "VC1=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "VC2=C:\Program Files\Microsoft Visual Studio\2026\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "VC3=C:\Program Files\Microsoft Visual Studio\2026\Community\VC\Auxiliary\Build\vcvars64.bat"
set "VC4=C:\Program Files\Microsoft Visual Studio\2026\Professional\VC\Auxiliary\Build\vcvars64.bat"
set "VC5=C:\Program Files\Microsoft Visual Studio\2026\Enterprise\VC\Auxiliary\Build\vcvars64.bat"
set "VC6=C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "VC7=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
set "VC8=C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat"

if exist "%VC1%" set "VCVARS=%VC1%"
if not defined VCVARS if exist "%VC2%" set "VCVARS=%VC2%"
if not defined VCVARS if exist "%VC3%" set "VCVARS=%VC3%"
if not defined VCVARS if exist "%VC4%" set "VCVARS=%VC4%"
if not defined VCVARS if exist "%VC5%" set "VCVARS=%VC5%"
if not defined VCVARS if exist "%VC6%" set "VCVARS=%VC6%"
if not defined VCVARS if exist "%VC7%" set "VCVARS=%VC7%"
if not defined VCVARS if exist "%VC8%" set "VCVARS=%VC8%"

if defined VCVARS goto :vc_found
echo [ERROR] Could not find vcvars64.bat under any known Visual Studio location.
echo         Install "Desktop development with C++" (VS Build Tools or VS),
echo         or add your vcvars64.bat path to VC1..VC8 near the top of this script.
pause
exit /b 1
:vc_found
echo [wheelhouse] VC env: %VCVARS%
call "%VCVARS%"
if errorlevel 1 (
  echo [ERROR] failed to initialize VC environment.
  pause
  exit /b 1
)

rem ---- 2. pick a Python 3.11 to build against (ABI must match end-user) ----
set "PY="
if exist "%ROOT%\tools\runtime\python\python.exe" set "PY=%ROOT%\tools\runtime\python\python.exe"
if not defined PY if exist "%ROOT%\venv\Scripts\python.exe" set "PY=%ROOT%\venv\Scripts\python.exe"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [ERROR] No Python 3.11 found. Run 03_fetch_runtimes.py first ^(embeds python 3.11^).
  pause
  exit /b 1
)
echo [wheelhouse] python: %PY%
"%PY%" --version

echo.
echo [wheelhouse] building wheels: %WHEEL_PKGS%
echo [wheelhouse] output dir     : %WHEELS%
echo.

"%PY%" -m pip install --upgrade pip "setuptools<81" wheel cmake >nul 2>nul

rem CMake >= 4.0 dropped compatibility with cmake_minimum_required(<3.5).
rem pyopenjtalk bundles hts_engine/open_jtalk whose CMakeLists still
rem declare 2.x/3.0 minimums, so a modern CMake refuses to configure them.
rem This env var (honored by CMake 3.31+) injects a 3.5 policy floor so the
rem old projects configure without editing their CMakeLists.
set "CMAKE_POLICY_VERSION_MINIMUM=3.5"

rem --no-deps: build ONLY the compile-needing targets. Their pure-python/ABI
rem deps (numpy, tqdm, colorama, ...) have PyPI wheels and are installed online
rem at deploy time per requirements.txt pins — no need to clutter tools\wheels.
"%PY%" -m pip wheel --no-deps %WHEEL_PKGS% -w "%WHEELS%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [wheelhouse] DONE. Wheels in %WHEELS%:
  dir /b "%WHEELS%\*.whl"
) else (
  echo [wheelhouse][ERROR] wheel build failed ^(code %RC%^).
  echo   - Ensure "Desktop development with C++" + CMake are installed in VS Build Tools.
  echo   - pyopenjtalk needs CMake; jieba_fast needs the MSVC compiler.
)
echo.
pause
endlocal
