@echo off
chcp 65001 >nul
title TTS Broker · Clean project root / 清理根目录 (开发者工具)
setlocal enabledelayedexpansion

rem tools\scripts -> tools -> <root>
set "HERE=%~dp0"
for %%I in ("%HERE%..\..") do set "ROOT=%%~fI"

echo ============================================================
echo   清理项目根目录 (开发者工具)
echo   ROOT = %ROOT%
echo ------------------------------------------------------------
echo   将删除历史遗留的临时脚本 / 打包产物 / 补丁解压残留。
echo   * 源码、模型、venv、tools、lib、web 不受影响。
echo   * 先列出清单; 需二次确认 (输入 YES) 才会真正删除。
echo ============================================================
echo.

rem ---- old temp / dev scripts (files) ----
rem  NOTE: download_models.py / download_ffmpeg.py have MOVED to tools\deploy\ .
rem  Remove the stale ROOT copies so there is a single source of truth (and the
rem  release zip won't ship duplicates). The canonical copies under tools\deploy
rem  are untouched.
set FILES=apply_gsv_patch3.py pack_sources.py pack_sources.cpython-312.pyc surgery.py test_phase4.js tree_report.txt configure_models.bat restart.bat run_start.bat start.ps1 start.vbs stop.ps1 stop.bat dump_tree.ps1 requirements.lock.current.txt download_models.py download_ffmpeg.py

rem ---- leftover folders from extracting an old distribution-kit patch ----
set DIRS=distribution-kit-patch root

echo [将删除的文件]
for %%F in (%FILES%) do (
  if exist "%ROOT%\%%F" echo    - %%F
)
echo.
echo [将删除的目录]
for %%D in (%DIRS%) do (
  if exist "%ROOT%\%%D\" echo    - %%D\
)
echo.

set /p CONFIRM=确认删除以上项目? 输入 YES 继续: 
if /I not "%CONFIRM%"=="YES" (
  echo 已取消, 未删除任何内容。
  echo.
  pause
  exit /b 0
)

echo.
for %%F in (%FILES%) do (
  if exist "%ROOT%\%%F" (
    del /f /q "%ROOT%\%%F" && echo   删除 %%F
  )
)
for %%D in (%DIRS%) do (
  if exist "%ROOT%\%%D\" (
    rmdir /s /q "%ROOT%\%%D" && echo   删除 %%D\
  )
)

echo.
echo [完成] 根目录已清理。
echo   提示: 启动/停止/首次部署 由根目录的 启动.bat / 停止.bat / 首次部署.bat 负责,
echo         真正的脚本都在 tools\ 下 (build / deploy / scripts)。
echo.
pause
endlocal
