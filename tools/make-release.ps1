<#
.SYNOPSIS
  Builds the release zip and its SHA-256 checksum for the self-hosted Gazette.

.DESCRIPTION
  The zip is made with `git archive` from the last commit, so it contains exactly
  what's in Git (no local data, no uncommitted edits). The SharePoint version
  (sharepoint/) is not included; it has its own build and install steps.

  Output:
    dist\staffroom-gazette-v<version>.zip
    dist\staffroom-gazette-v<version>.zip.sha256   (sha256sum format)

.EXAMPLE
  npm run release
  powershell -ExecutionPolicy Bypass -File tools\make-release.ps1
#>
[CmdletBinding()]
param([string]$Version = '')

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$pkgVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Version) { $Version = $pkgVersion }
if ($Version -ne $pkgVersion) { throw "package.json says $pkgVersion but you asked for $Version. Update package.json first." }

$dirty = git status --porcelain
if ($dirty) { throw "There are uncommitted changes. Commit them first: the release is built from the last commit.`n$($dirty -join "`n")" }

$name = "staffroom-gazette-v$Version"
$dist = Join-Path (Get-Location) 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }

$paths = @('Install.cmd', 'installer', 'lib', 'public', 'server.js', 'package.json', 'README.md', 'LICENSE')
& git archive --format=zip "--prefix=$name/" -o $zip HEAD -- $paths
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }

$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zip.sha256", "$hash  $name.zip`n", (New-Object Text.UTF8Encoding($false)))

$commit = (git rev-parse --short HEAD).Trim()
$sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ''
Write-Host "  Built $name from commit $commit" -ForegroundColor Green
Write-Host "  $zip  ($sizeMb MB)"
Write-Host "  $zip.sha256"
Write-Host "  SHA-256: $hash"
