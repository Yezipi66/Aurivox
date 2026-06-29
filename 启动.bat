@echo off
chcp 65001 >nul
title TTS Broker Launcher
powershell -ExecutionPolicy Bypass -NoProfile -NoExit -File "%~dp0start.ps1"
