@echo off
chcp 65001 >nul
title TTS Broker

:: 获取脚本目录
set BASE_DIR=%~dp0

:: 检查端口占用
netstat -ano | findstr ":9880 " >nul 2>&1
if %errorlevel%==0 (
    echo [WARN] Port 9880 already in use, inference server may already be running.
)

netstat -ano | findstr ":9886 " >nul 2>&1
if %errorlevel%==0 (
    echo [WARN] Port 9886 already in use, server may already be running.
)

:: 启动自包含推理服务 :9880 (本项目 lib\inference\infer_server.py, 不再依赖外部引擎)
echo [1/3] Starting self-contained inference server :9880 ...
start "TTS Inference Server" cmd /k "cd /d %BASE_DIR% && venv\Scripts\python.exe lib\inference\infer_server.py -a 127.0.0.1 -p 9880 -c lib\inference\tts_infer.yaml"

:: 等推理服务启动 (首次加载模型较慢, 后端自身也会做健康检查)
timeout /t 20 /nobreak >nul

:: 启动后端
echo [2/3] Starting backend :9886 ...
start "TTS Broker Backend" cmd /k "cd /d %BASE_DIR% && node server.js"

:: 等后端启动
timeout /t 5 /nobreak >nul

:: 前端: 生产构建由后端 :9886 托管, 无需 Vite 开发服务器。
:: 仅在 dist 不存在时构建一次 (之后启动秒开)。
echo [3/3] Preparing frontend (served by backend :9886) ...
if not exist "%BASE_DIR%web\dist\assets" (
    echo       Building frontend ^(one-time^) ...
    pushd "%BASE_DIR%web"
    if not exist "node_modules" npm install
    call npm run build
    popd
) else (
    echo       Using existing build.
)

echo.
echo ========================================
echo   TTS Broker started!
echo   Inference: http://127.0.0.1:9880
echo   Backend:   http://127.0.0.1:9886
echo   Open UI:   http://127.0.0.1:9886
echo ========================================
echo.
echo Press any key to exit (servers will keep running)...
pause >nul
