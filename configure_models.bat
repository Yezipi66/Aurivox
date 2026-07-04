@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title GPT-SoVITS 底模配置向导

rem ============================================================
rem  configure_models.bat
rem  引导式底模下载向导，封装 download_models.py。
rem  放在项目根目录（download_models.py 同级）双击即可运行。
rem ============================================================

cd /d "%~dp0"

rem ---- 定位 Python：优先项目内 venv，其次系统 python ----
set "PY="
if exist "venv\Scripts\python.exe" set "PY=venv\Scripts\python.exe"
if not defined PY if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo [错误] 未找到 Python。请先激活虚拟环境或安装 Python 后重试。
    pause
    exit /b 1
)

if not exist "download_models.py" (
    echo [错误] 未在当前目录找到 download_models.py。
    echo         请把本 bat 和 download_models.py 一起放在项目根目录。
    pause
    exit /b 1
)

rem ---- 是否使用国内镜像加速 ----
set "MIRROR="
echo.
set /p USEMIRROR=是否使用国内镜像(hf-mirror.com)加速下载? [Y/n]: 
if /i "!USEMIRROR!"=="n" (
    set "MIRROR="
) else (
    set "MIRROR=--mirror"
)

:MENU
echo.
echo ============================================================
echo            GPT-SoVITS 底模下载配置向导
echo ============================================================
echo   1^) 最佳体验 ^(下载全部底模: v2 + v2Pro + v2ProPlus + SV^)
echo   2^) 仅 v2ProPlus  ^(质量最高, 含 SV^)
echo   3^) 仅 v2Pro      ^(质量较高, 含 SV^)
echo   4^) 仅 v2         ^(补齐真正的 v2 底模 s2G2333k, 修复电流声/质量^)
echo   5^) 自定义组合    ^(手动输入: v2,v2pro,v2proplus,sv,s1^)
echo   6^) 体检          ^(只检查本地底模是否齐全, 不下载^)
echo   0^) 退出
echo ------------------------------------------------------------
set /p CHOICE=请选择 [0-6]: 

if "%CHOICE%"=="1" set "SET_ARG=all"       & goto RUN
if "%CHOICE%"=="2" set "SET_ARG=v2proplus" & goto RUN
if "%CHOICE%"=="3" set "SET_ARG=v2pro"     & goto RUN
if "%CHOICE%"=="4" set "SET_ARG=v2"        & goto RUN
if "%CHOICE%"=="5" goto CUSTOM
if "%CHOICE%"=="6" goto CHECK
if "%CHOICE%"=="0" goto END
echo 无效选择，请重试。
goto MENU

:CUSTOM
echo.
echo 可选组: v2  v2pro  v2proplus  sv  s1  all
set /p SET_ARG=请输入(逗号分隔): 
if "%SET_ARG%"=="" (
    echo 未输入，返回菜单。
    goto MENU
)
goto RUN

:CHECK
echo.
"%PY%" download_models.py --check
echo.
pause
goto MENU

:RUN
echo.
echo 即将下载模型组: %SET_ARG%
echo 命令: "%PY%" download_models.py --set %SET_ARG% %MIRROR%
echo.
"%PY%" download_models.py --set %SET_ARG% %MIRROR%
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
    echo [完成] 下载成功。
) else (
    echo [提示] 部分文件可能未成功，可重跑本向导^(支持断点续传^)或切换镜像/源。
)
echo.
pause
goto MENU

:END
echo 已退出。
endlocal
exit /b 0
