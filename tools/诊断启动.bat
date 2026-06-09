@echo off
setlocal
set DM_DIAG=1

if "%~1"=="" (
  echo Usage: drag DanceMonkey.exe onto this bat, or:
  echo   诊断启动.bat "C:\temp\DanceMonkey\xxx\DanceMonkey.exe"
  pause
  exit /b 1
)

set "EXE=%~1"
if not exist "%EXE%" (
  echo [ERROR] Not found: %EXE%
  pause
  exit /b 1
)

echo Running: %EXE% --diag
pushd "%~dp1"
"%EXE%" --diag
set ERR=%ERRORLEVEL%
popd

echo.
echo Exit code: %ERR%
echo.
set "LOG=%LOCALAPPDATA%\DanceMonkey\logs\startup.log"
set "CRASH=%LOCALAPPDATA%\DanceMonkey\logs\crash.log"
if exist "%LOG%" (
  echo === startup.log ===
  type "%LOG%"
) else (
  echo startup.log not found.
)
if exist "%CRASH%" (
  echo.
  echo === crash.log (tail) ===
  powershell -NoProfile -Command "Get-Content -LiteralPath '%CRASH%' -Tail 40"
)
echo.
pause
exit /b %ERR%
