@echo off
chcp 65001 >nul
title TTS Broker · Pack source zip / 打包源码 (开发者工具)
rem tools\Build\pack-src.bat —— 双击或命令行运行即可。
rem 仅是个薄壳：真正的逻辑在同目录的 pack-src.ps1 (PowerShell 语法更好用)。
rem 参数会原样透传，例如:  pack-src.bat -Out D:\out\my.zip -NoTimestamp
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pack-src.ps1" %*
echo.
pause
