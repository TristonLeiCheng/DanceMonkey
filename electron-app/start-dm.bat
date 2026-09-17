@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title DM Launcher

where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERR ] PowerShell is required to start DM.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dm.ps1"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [ERR ] Launch failed. Code=%CODE%
  pause
)
exit /b %CODE%
