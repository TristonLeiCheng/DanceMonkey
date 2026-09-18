@echo off
setlocal EnableExtensions
REM Run DanceMonkey from %LOCALAPPDATA% (avoids UNC execute block and incomplete network copies).

set "SRC=%~dp0"
if not exist "%SRC%DanceMonkey.exe" (
  echo [ERROR] DanceMonkey.exe not found in: %SRC%
  echo Put this script in the same folder as DanceMonkey.exe, or re-run publish.bat.
  pause
  exit /b 1
)

set "DEST=%LOCALAPPDATA%\DanceMonkey\app"
echo Copying to %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
robocopy "%SRC%" "%DEST%" /E /R:2 /W:2 /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 (
  echo [ERROR] Copy failed.
  pause
  exit /b 1
)

echo Starting DanceMonkey...
start "" "%DEST%\DanceMonkey.exe"
exit /b 0
