@echo off
setlocal EnableExtensions

pushd "%~dp0" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Unable to enter script directory: "%~dp0"
  pause
  exit /b 1
)

echo ==========================================
echo DanceMonkey Publish Script (win-x64)
echo ==========================================
echo.

where dotnet >nul 2>nul
if errorlevel 1 (
  echo [ERROR] dotnet CLI not found in PATH.
  pause
  exit /b 1
)

taskkill /F /IM DanceMonkey.exe >nul 2>nul
taskkill /F /IM DesktopAssistant.exe >nul 2>nul

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set TS=%%i
set "PROJECT=%~dp0DesktopAssistant.csproj"
set "CLI_PROJECT=%~dp0DanceMonkey.Cli\DanceMonkey.Cli.csproj"

for /f %%i in ('powershell -NoProfile -Command "[xml]$proj = Get-Content -LiteralPath '%PROJECT%'; $version = @($proj.Project.PropertyGroup.Version | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -First 1); if ($version) { $version } else { '0.0.0' }"') do set "APP_VERSION=%%i"

REM Always publish to local disk (UNC cannot reliably hold exe/dll; Windows may block running from UNC).
set "BUILD_DIR=C:\temp\DanceMonkey\%TS%"
set "OUT_DIR=%~dp0publish\win-x64\%TS%"
set "CLI_BUILD_DIR=%BUILD_DIR%\cli"
set "MAIN_EXE=%BUILD_DIR%\DanceMonkey.exe"
set "CLI_EXE=%CLI_BUILD_DIR%\dancemonkey.exe"
set "CLI_EXE_COPY=%BUILD_DIR%\dancemonkey-cli.exe"
set "ARTIFACTS_DIR=%~dp0publish\win-x64\artifacts"
set "PACKAGE_FILE=DanceMonkey-win-x64-%APP_VERSION%.zip"
set "PACKAGE_PATH=%ARTIFACTS_DIR%\%PACKAGE_FILE%"
set "MANIFEST_PATH=%ARTIFACTS_DIR%\update-manifest.json"
set "LAST_LOCAL_TXT=%~dp0publish\win-x64\LAST-LOCAL-BUILD.txt"

if not exist "%PROJECT%" (
  echo [ERROR] Project file not found: "%PROJECT%"
  pause
  exit /b 1
)

set HTTP_PROXY=
set HTTPS_PROXY=
set http_proxy=
set https_proxy=
set ALL_PROXY=
set all_proxy=
set NO_PROXY=*
set no_proxy=*
set NUGET_AUDIT=false
set "NUGET_FALLBACK_PACKAGES="

if not exist "C:\temp\DanceMonkey" mkdir "C:\temp\DanceMonkey" >nul 2>nul

echo [INFO] Publish output (run from here): %BUILD_DIR%
echo.

echo [1/7] Restoring solution...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\restore-solution.ps1"
if errorlevel 1 (
  echo [WARN] Restore failed; will try publish with --no-restore if packages are cached.
)

echo.
echo [2/7] Publishing DanceMonkey (WPF) self-contained...
if not exist "%BUILD_DIR%" mkdir "%BUILD_DIR%"
dotnet publish "%PROJECT%" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -p:PublishTrimmed=false -p:PublishDir="%BUILD_DIR%\." -p:RestoreFallbackFolders="" -p:DisableImplicitNuGetFallbackFolder=true -p:NuGetAudit=false
if errorlevel 1 (
  dotnet publish "%PROJECT%" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -p:PublishTrimmed=false -p:PublishDir="%BUILD_DIR%\." -p:RestoreFallbackFolders="" -p:DisableImplicitNuGetFallbackFolder=true -p:NuGetAudit=false --no-restore
)
if errorlevel 1 goto :publish_failed

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\verify-publish.ps1" -Dir "%BUILD_DIR%"
if errorlevel 1 goto :publish_incomplete

echo.
echo [3/7] Publishing dancemonkey CLI...
if not exist "%CLI_BUILD_DIR%" mkdir "%CLI_BUILD_DIR%"
dotnet publish "%CLI_PROJECT%" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:PublishDir="%CLI_BUILD_DIR%\." -p:RestoreFallbackFolders="" -p:DisableImplicitNuGetFallbackFolder=true -p:NuGetAudit=false
if errorlevel 1 (
  dotnet publish "%CLI_PROJECT%" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:PublishTrimmed=false -p:PublishDir="%CLI_BUILD_DIR%\." -p:RestoreFallbackFolders="" -p:DisableImplicitNuGetFallbackFolder=true -p:NuGetAudit=false --no-restore
)
if errorlevel 1 (
  echo [WARN] CLI publish failed. Continuing.
) else (
  if exist "%CLI_EXE%" copy /Y "%CLI_EXE%" "%CLI_EXE_COPY%" >nul
)

copy /Y "%~dp0tools\Install-LocalRun.bat" "%BUILD_DIR%\启动 DanceMonkey.bat" >nul
copy /Y "%~dp0tools\Install-LocalRun.bat" "%BUILD_DIR%\Run-DanceMonkey-Local.bat" >nul
copy /Y "%~dp0tools\诊断启动.bat" "%BUILD_DIR%\诊断启动.bat" >nul

echo.
echo [4/7] Copying to network folder (optional archive)...
if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
robocopy "%BUILD_DIR%" "%OUT_DIR%" /E /R:2 /W:2 /NFL /NDL /NJH /NJS /nc /ns /np
if errorlevel 8 (
  echo [WARN] Network copy failed. Use local build: %BUILD_DIR%
) else (
  copy /Y "%~dp0tools\Install-LocalRun.bat" "%OUT_DIR%\启动 DanceMonkey.bat" >nul
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\verify-publish.ps1" -Dir "%OUT_DIR%"
  if errorlevel 1 (
    echo [WARN] Network folder incomplete - do NOT run exe from UNC. Use: %BUILD_DIR%
  )
)

echo %BUILD_DIR%> "%LAST_LOCAL_TXT%"

echo.
echo [5/7] Creating update package...
if not exist "%ARTIFACTS_DIR%" mkdir "%ARTIFACTS_DIR%"
powershell -NoProfile -Command "Compress-Archive -Path (Get-ChildItem -LiteralPath '%BUILD_DIR%' -Force).FullName -DestinationPath '%PACKAGE_PATH%' -Force"
if errorlevel 1 goto :zip_failed

echo.
echo [6/7] Writing update manifest...
powershell -NoProfile -Command "$manifest = [ordered]@{ version = '%APP_VERSION%'; packageUrl = '%PACKAGE_FILE%'; entryExe = 'DanceMonkey.exe' }; $manifest | ConvertTo-Json | Set-Content -LiteralPath '%MANIFEST_PATH%' -Encoding utf8"
if errorlevel 1 (
  echo [ERROR] Failed to write update manifest.
  pause
  exit /b 1
)

echo.
echo [7/7] Done.
echo.
echo ==========================================
echo 请从本机目录启动（不要双击 UNC 上的 DanceMonkey.exe）:
echo   %BUILD_DIR%\启动 DanceMonkey.bat
echo   或: %BUILD_DIR%\DanceMonkey.exe
echo.
echo 网络归档副本: %OUT_DIR%
echo 更新包: %PACKAGE_PATH%
echo ==========================================

start "" "%BUILD_DIR%"

popd >nul 2>nul
pause
exit /b 0

:publish_failed
echo.
echo [ERROR] dotnet publish failed.
pause
exit /b 1

:publish_incomplete
echo.
echo [ERROR] Publish incomplete (missing exe or runtime dlls).
echo        Check: %BUILD_DIR%
pause
exit /b 1

:zip_failed
echo.
echo [ERROR] Failed to create update package.
pause
exit /b 1
