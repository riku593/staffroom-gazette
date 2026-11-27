<#
.SYNOPSIS
  Builds the Staffroom Gazette MSI installer (Windows x64) and its SHA-256 checksum.

.DESCRIPTION
  1. Sets up WiX Toolset 5.0.2 as a local dotnet tool (MS-RL licence; no install needed)
  2. Downloads Node.js (win-x64) from nodejs.org and checks it against SHASUMS256.txt
  3. Compiles the service wrapper with the C# compiler that ships with Windows
  4. Stages the app from the last commit (git archive), like the zip release
  5. Builds dist\staffroom-gazette-v<version>-x64.msi and a .sha256 file

  Requires: .NET SDK 6 or newer (for the wix tool), Git, Windows with .NET Framework 4.

.EXAMPLE
  npm run msi
  powershell -ExecutionPolicy Bypass -File tools\build-msi.ps1 -AllowDirty   # test build from working copy
#>
[CmdletBinding()]
param(
  [string]$NodeVersion = '24.22.3',
  [switch]$AllowDirty    # stage the working copy instead of the last commit (for testing only)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$WixVersion = '5.0.2'

function Step([string]$m) { Write-Host ''; Write-Host "> $m" -ForegroundColor Cyan }

$Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $AllowDirty) {
  $dirty = git status --porcelain
  if ($dirty) { throw "There are uncommitted changes. Commit them first (the MSI is built from the last commit), or use -AllowDirty for a test build." }
}

$build = Join-Path $Root 'build'
$cache = Join-Path $build 'cache'
$stage = Join-Path $build 'msi-stage'
$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $cache, $dist | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app'), (Join-Path $stage 'node') | Out-Null

# ---------------------------------------------------------------------------
Step "WiX Toolset $WixVersion"
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'The .NET SDK is needed to build the MSI: https://dotnet.microsoft.com/download' }
if (-not (Test-Path (Join-Path $Root '.config\dotnet-tools.json'))) { & dotnet new tool-manifest | Out-Null }
& dotnet tool install wix --version $WixVersion 2>$null | Out-Null
& dotnet tool restore | Out-Null
foreach ($ext in 'WixToolset.Util.wixext', 'WixToolset.UI.wixext', 'WixToolset.Firewall.wixext') {
  & dotnet wix extension add "$ext/$WixVersion" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not add WiX extension $ext" }
}
Write-Host "  wix $(& dotnet wix --version)"

# ---------------------------------------------------------------------------
Step "Node.js $NodeVersion (win-x64)"
$nodeZipName = "node-v$NodeVersion-win-x64.zip"
$nodeZip = Join-Path $cache $nodeZipName
$sums = Join-Path $cache "SHASUMS256-v$NodeVersion.txt"
$base = "https://nodejs.org/dist/v$NodeVersion"
if (-not (Test-Path $sums)) { Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt" -OutFile $sums }
if (-not (Test-Path $nodeZip)) {
  Write-Host "  Downloading $nodeZipName ..."
  Invoke-WebRequest -UseBasicParsing "$base/$nodeZipName" -OutFile $nodeZip
}
$expected = (Select-String -Path $sums -Pattern ([regex]::Escape($nodeZipName) + '$')).Line.Split(' ')[0]
$actual = (Get-FileHash -Algorithm SHA256 $nodeZip).Hash.ToLowerInvariant()
if (-not $expected -or $expected -ne $actual) {
  Remove-Item -Force $nodeZip
  throw "Checksum mismatch for $nodeZipName (expected $expected, got $actual). The download was deleted; run again."
}
Write-Host "  Verified SHA-256 against nodejs.org SHASUMS256.txt"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead($nodeZip)
try {
  foreach ($entry in $z.Entries) {
    $leaf = $entry.FullName.Substring($entry.FullName.IndexOf('/') + 1)
    if ($leaf -in 'node.exe', 'LICENSE') {
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stage "node\$leaf"), $true)
    }
  }
} finally { $z.Dispose() }
if (-not (Test-Path (Join-Path $stage 'node\node.exe'))) { throw 'node.exe not found in the Node.js zip' }

# ---------------------------------------------------------------------------
Step 'Service wrapper'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc (.NET Framework 4 is required)" }
& $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$(Join-Path $stage 'StaffroomGazetteService.exe')" `
  /reference:System.ServiceProcess.dll (Join-Path $Root 'installer\msi\service\GazetteService.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compiling the service wrapper failed' }
Write-Host '  StaffroomGazetteService.exe compiled'

# ---------------------------------------------------------------------------
Step 'App files'
$appPaths = @('server.js', 'package.json', 'README.md', 'LICENSE', 'lib', 'public')
if ($AllowDirty) {
  foreach ($p in $appPaths) { Copy-Item -Recurse -Force (Join-Path $Root $p) (Join-Path $stage 'app') }
  Write-Host '  Copied from the working copy (test build)'
} else {
  $tmpZip = Join-Path $build 'app.zip'
  & git archive --format=zip -o $tmpZip HEAD -- $appPaths
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  Expand-Archive -Force $tmpZip (Join-Path $stage 'app')
  Remove-Item -Force $tmpZip
  Write-Host "  From commit $((git rev-parse --short HEAD).Trim())"
}

# Licence shown in the installer (Apache-2.0), as RTF.
$text = Get-Content (Join-Path $Root 'LICENSE') -Raw
$escaped = $text.Replace('\', '\\').Replace('{', '\{').Replace('}', '\}') -replace "`r?`n", "\par`r`n"
$rtf = '{\rtf1\ansi\deff0{\fonttbl{\f0\fswiss Segoe UI;}}\f0\fs17 ' + $escaped + '}'
[IO.File]::WriteAllText((Join-Path $stage 'License.rtf'), $rtf, [Text.Encoding]::ASCII)

# ---------------------------------------------------------------------------
Step 'Building the MSI'
$msiName = "staffroom-gazette-v$Version-x64.msi"
$msi = Join-Path $dist $msiName
& dotnet wix build (Join-Path $Root 'installer\msi\StaffroomGazette.wxs') -arch x64 `
  -ext WixToolset.Util.wixext -ext WixToolset.UI.wixext -ext WixToolset.Firewall.wixext `
  -d "Version=$Version" -d "StageDir=$stage" -o $msi
if ($LASTEXITCODE -ne 0) { throw 'wix build failed' }
Remove-Item -Force (Join-Path $dist "staffroom-gazette-v$Version-x64.wixpdb") -ErrorAction SilentlyContinue

$hash = (Get-FileHash -Algorithm SHA256 $msi).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$msi.sha256", "$hash  $msiName`n", (New-Object Text.UTF8Encoding($false)))

$sizeMb = [math]::Round((Get-Item $msi).Length / 1MB, 1)
Write-Host ''
Write-Host "  Built $msiName ($sizeMb MB) with Node.js $NodeVersion" -ForegroundColor Green
Write-Host "  $msi"
Write-Host "  $msi.sha256"
Write-Host "  SHA-256: $hash"
