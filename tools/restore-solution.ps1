# Restore solution; bypass corporate proxy when possible.
param(
    [string]$SolutionPath = (Join-Path $PSScriptRoot "..\DesktopAssistant.sln"),
    [switch]$AllowProxy
)

$ErrorActionPreference = "Stop"

if (-not $AllowProxy) {
    $env:HTTP_PROXY = ""
    $env:HTTPS_PROXY = ""
    $env:http_proxy = ""
    $env:https_proxy = ""
    $env:ALL_PROXY = ""
    $env:all_proxy = ""
    $env:NO_PROXY = "*"
    $env:no_proxy = "*"
    try {
        [System.Net.WebRequest]::DefaultWebProxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
    }
    catch {
        [System.Net.WebRequest]::DefaultWebProxy = $null
    }
}

$env:NUGET_AUDIT = "false"

Write-Host "Restoring: $SolutionPath"
& dotnet restore $SolutionPath `
    -p:NuGetAudit=false `
    -p:RestoreFallbackFolders="" `
    -p:DisableImplicitNuGetFallbackFolder=true

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Restore failed." -ForegroundColor Yellow
    Write-Host "  NU1301 / HTTP 407: configure proxy credentials in %AppData%\NuGet\NuGet.Config"
    Write-Host "  Or run restore once on a machine with nuget.org access."
    Write-Host "  UNC path: map a drive first, e.g. subst Z: \\server\share"
    exit $LASTEXITCODE
}

Write-Host "Restore OK." -ForegroundColor Green
exit 0
