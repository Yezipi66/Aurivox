@echo off
chcp 65001 >nul
title TTS Broker

:: 获取脚本目录
set BASE_DIR=%~dp0

:: 检查端口占用
netstat -ano | findstr ":9880 " >nul 2>&1
if %errorlevel%==0 (
    echo [WARN] Port 9880 already in use, engine may already be running.
)

netstat -ano | findstr ":9886 " >nul 2>&1
if %errorlevel%==0 (
    echo [WARN] Port 9886 already in use, server may already be running.
)

netstat -ano | findstr ":5173 " >nul 2>&1
if %errorlevel%==0 (
    echo [WARN] Port 5173 already in use, frontend may already be running.
)

:: 启动 GPT-SoVITS 推理引擎 :9880
echo [1/3] Starting GPT-SoVITS engine :9880 ...
start "GPT-SoVITS Engine" cmd /k "cd /d D:\AI\GPT-SoVITS-v2pro-20250604 && runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml"

:: 等引擎启动（首次加载模型较慢）
timeout /t 15 /nobreak >nul

:: 启动后端
echo [2/3] Starting backend :9886 ...
start "TTS Broker Backend" cmd /k "cd /d %BASE_DIR% && node server.js"

:: 等后端启动
timeout /t 5 /nobreak >nul

:: 启动前端
echo [3/3] Starting frontend :5173 ...
start "TTS Broker Frontend" cmd /k "cd /d %BASE_DIR%web && npm run dev"

echo.
echo ========================================
echo   TTS Broker started!
echo   Engine:   http://127.0.0.1:9880
echo   Backend:  http://127.0.0.1:9886
echo   Frontend: http://127.0.0.1:5173
echo ========================================
echo.
echo Press any key to exit (servers will keep running)...
pause >nul