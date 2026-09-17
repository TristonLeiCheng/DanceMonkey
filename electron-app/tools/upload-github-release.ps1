#!/usr/bin/env pwsh
# 将本地已打包的 3.0.0 产物上传到 GitHub Release，供旧版「检查并更新」拉取。
# 用法（在能访问 GitHub 的网络下）：
#   pwsh -File tools/upload-github-release.ps1
# 需要：gh 已登录，且对 TristonLeiCheng/DanceMonkey 有写权限。

param(
  [string]$Repo = "TristonLeiCheng/DanceMonkey",
  [string]$Version = "3.0.0",
  [string]$ArtifactsDir = ""
)

$ErrorActionPreference = "Stop"

if (-not $ArtifactsDir) {
  $candidates = @(
    (Join-Path $PSScriptRoot "..\publish\win-x64\artifacts"),
    "Z:\DanceMonkey3.0\publish\win-x64\artifacts",
    "Z:\DanceMonkey\DanceMonkey\publish\win-x64\artifacts"
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c "update-manifest.json")) {
      $ArtifactsDir = (Resolve-Path $c).Path
      break
    }
  }
}

if (-not $ArtifactsDir) {
  throw "未找到 artifacts 目录，请先运行: node tools/publish-electron-release.mjs"
}

$zip = Join-Path $ArtifactsDir "DanceMonkey-win-x64-$Version.zip"
$manifest = Join-Path $ArtifactsDir "update-manifest.json"
if (-not (Test-Path $zip)) { throw "缺少 $zip" }
if (-not (Test-Path $manifest)) { throw "缺少 $manifest" }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "未安装 GitHub CLI (gh)。请安装后执行: gh auth login"
}

$tag = "v$Version"
$notes = @"
## DanceMonkey $Version (Electron)

旧版点击「检查并更新」可直接升级到本版本。

- 磨砂快捷轨 + 完整工作区
- Zen Task / 快速访问 / 文件夹同步
- 在线升级（兼容旧版 manifest 协议）

安装包：``DanceMonkey-win-x64-$Version.zip``
"@

Write-Host "[INFO] Creating release $tag on $Repo"
gh release view $tag --repo $Repo 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "[INFO] Release exists, uploading assets..."
  gh release upload $tag $zip $manifest --repo $Repo --clobber
} else {
  gh release create $tag $zip $manifest --repo $Repo --title "DanceMonkey $Version" --notes $notes
}

Write-Host "[OK] Release published: https://github.com/$Repo/releases/tag/$tag"
Write-Host "[OK] 旧版默认会检查该仓库 latest release（资源名含 win-x64）。"
