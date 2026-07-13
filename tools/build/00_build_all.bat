@echo off
chcp 65001 >nul
title TTS Broker · Build release (all steps)
setlocal

set "BUILD_DIR=%~dp0"
for %%I in ("%BUILD_DIR%..\..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

echo ============================================================
echo   TTS Broker  发布构建 (开发者侧, 在你的机器上运行)
echo   顺序: 03 拉运行时 -^> 01 建前端/根依赖 -^> 02 造轮子 -^> 04 打包
echo ============================================================
echo.

set "SYS_PY=python"

echo [1/4] 拉取内嵌运行时 (python + node) ...
"%SYS_PY%" "%ROOT%\tools\build\03_fetch_runtimes.py"
if errorlevel 1 ( echo [ERROR] 03_fetch_runtimes 失败 & pause & exit /b 1 )

echo.
echo [2/4] 构建前端 + 根 Node 依赖 ...
call "%ROOT%\tools\build\01_build_frontend.bat"

echo.
echo [3/4] 编译轮子 (jieba_fast / pyopenjtalk, 需 VC 环境) ...
call "%ROOT%\tools\build\02_make_wheelhouse.bat"

echo.
echo [4/4] 打包 release zip ...
"%ROOT%\tools\runtime\python\python.exe" "%ROOT%\tools\build\04_pack_release.py" %*
if errorlevel 1 (
  "%SYS_PY%" "%ROOT%\tools\build\04_pack_release.py" %*
)

echo.
echo [完成] 发布包在 dist\ 下。
pause
endlocal
