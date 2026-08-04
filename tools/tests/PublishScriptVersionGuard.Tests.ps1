$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot 'publish.bat'
$script = Get-Content -Raw -LiteralPath $scriptPath

$requiredFragments = @(
    'PUBLISH_ALLOW_SAME_VERSION',
    'PREVIOUS_MANIFEST_VERSION',
    ':version_not_bumped',
    'A newer application version is required for an online update package'
)

$missing = $requiredFragments | Where-Object { -not $script.Contains($_) }
if ($missing) {
    throw "publish.bat is missing the same-version update-package guard: $($missing -join ', ')"
}

if ($script.Contains('^| ConvertFrom-Json') -or
    -not $script.Contains("ConvertFrom-Json (Get-Content -Raw -LiteralPath '%MANIFEST_PATH%')")) {
    throw 'publish.bat must read the previous manifest without passing cmd.exe caret escaping to PowerShell.'
}

function Get-ProjectVersionMetadata([string] $projectPath) {
    [xml] $project = Get-Content -LiteralPath $projectPath
    $propertyGroup = @($project.Project.PropertyGroup | Where-Object { $_.Version } | Select-Object -First 1)
    if (-not $propertyGroup) {
        throw "Project is missing a Version property: $projectPath"
    }

    return [pscustomobject]@{
        Version = [string] $propertyGroup.Version
        FileVersion = [string] $propertyGroup.FileVersion
        AssemblyVersion = [string] $propertyGroup.AssemblyVersion
        InformationalVersion = [string] $propertyGroup.InformationalVersion
    }
}

$desktop = Get-ProjectVersionMetadata (Join-Path $repoRoot 'DesktopAssistant.csproj')
$cli = Get-ProjectVersionMetadata (Join-Path $repoRoot 'DanceMonkey.Cli\DanceMonkey.Cli.csproj')

foreach ($metadata in @($desktop, $cli)) {
    if ([string]::IsNullOrWhiteSpace($metadata.Version) -or
        $metadata.FileVersion -ne "$($metadata.Version).0" -or
        $metadata.AssemblyVersion -ne "$($metadata.Version).0" -or
        $metadata.InformationalVersion -ne $metadata.Version) {
        throw "Project version metadata is inconsistent: $($metadata | ConvertTo-Json -Compress)"
    }
}

if ($desktop.Version -ne $cli.Version) {
    throw "Desktop and CLI versions must match: desktop=$($desktop.Version), cli=$($cli.Version)"
}

Write-Host "PASS: publish.bat version guard and project metadata are valid for $($desktop.Version)." -ForegroundColor Green
