param(
    [Parameter(Mandatory = $true)]
    [string]$Dir
)

$exe = Join-Path $Dir "DanceMonkey.exe"
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "FAIL: missing DanceMonkey.exe" -ForegroundColor Red
    exit 1
}

$len = (Get-Item -LiteralPath $exe).Length
if ($len -lt 100000) {
    Write-Host "FAIL: DanceMonkey.exe too small ($len bytes)" -ForegroundColor Red
    exit 1
}

$dllCount = (Get-ChildItem -LiteralPath $Dir -Filter "*.dll" -File -ErrorAction SilentlyContinue).Count
if ($dllCount -lt 50) {
    Write-Host "FAIL: only $dllCount dll files (expected 50+)" -ForegroundColor Red
    exit 1
}

Write-Host "OK: exe=$len bytes, dll_count=$dllCount" -ForegroundColor Green
exit 0
