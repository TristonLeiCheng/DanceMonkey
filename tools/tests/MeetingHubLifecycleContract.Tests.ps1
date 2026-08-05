$ErrorActionPreference = 'Stop'

$htmlPath = Join-Path $PSScriptRoot '..\..\Assets\meeting-hub.html'
$html = Get-Content -Raw -Encoding UTF8 $htmlPath

$required = @(
    'lifecycle-stepper',
    'manual-notes-editor',
    'data-act="completeMeeting"',
    'data-convert="action"',
    'data-convert="decision"',
    'notes-source'
)

foreach ($needle in $required) {
    if ($html -notmatch [regex]::Escape($needle)) {
        throw "Missing lifecycle UI contract: $needle"
    }
}

foreach ($forbidden in @('audio', 'microphone', 'waveform', 'speech-to-text')) {
    if ($html -match [regex]::Escape($forbidden)) {
        throw "Forbidden voice UI contract: $forbidden"
    }
}

if ($html -match 'class="app-sidebar"') {
    throw 'The meeting WebView must not create an application-level left sidebar.'
}

$servicePath = Join-Path $PSScriptRoot '..\..\Services\MeetingHubService.cs'
$service = Get-Content -Raw -Encoding UTF8 $servicePath
foreach ($needle in @('case "completeMeeting":', 'CompleteMeetingAsync()', '_workbench.Status = MeetingStatus.Completed', 'await GenerateSummaryAsync();')) {
    if ($service -notmatch [regex]::Escape($needle)) {
        throw "Missing complete-meeting service contract: $needle"
    }
}

$todoPath = Join-Path $PSScriptRoot '..\..\Views\TodoView.xaml.cs'
$todo = Get-Content -Raw -Encoding UTF8 $todoPath
$ambiguousSplit = ".Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)"
if ($todo -match [regex]::Escape($ambiguousSplit)) {
    throw 'TodoView must use an explicitly typed character array when splitting lines.'
}

$typedSplit = "new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries"
if (($todo.Split($typedSplit).Length - 1) -lt 2) {
    throw 'Expected both TodoView line-splitting call sites to use the explicit character array.'
}

Write-Output 'Meeting hub lifecycle contract passed.'
