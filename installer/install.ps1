<#
.SYNOPSIS
  Installs (or updates) Staffroom Gazette on Windows.

.DESCRIPTION
  - Checks for Node.js 22.13 or newer (offers to install it with winget)
  - Copies the app to Program Files and keeps data separately in ProgramData
  - Runs the Gazette in the background at startup (a scheduled task as SYSTEM)
  - Opens the chosen port in Windows Firewall for Domain and Private networks
  - Adds Start menu shortcuts and an entry in Settings > Apps

  Running it again updates an existing install and keeps all notices and accounts.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Port 8080 -Quiet
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Staffroom Gazette'),
  [string]$DataDir = (Join-Path $env:ProgramData 'Staffroom Gazette'),
  [switch]$NoAutoStart,   # don't run in the background at startup
  [switch]$NoFirewall,    # don't add a firewall rule
  [switch]$NoBrowser,     # don't open the browser at the end
  [switch]$Quiet,         # no questions; use defaults
  [switch]$Elevated       # internal: set when the script relaunches itself as administrator
)

$ErrorActionPreference = 'Stop'
$AppName = 'Staffroom Gazette'
$TaskName = 'Staffroom Gazette'
$RegKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StaffroomGazette'
$StartMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Staffroom Gazette'
$MinNode = [version]'22.13.0'
$Source = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$m) { Write-Host ''; Write-Host "> $m" -ForegroundColor Cyan }
function Write-Ok([string]$m) { Write-Host "  $m" -ForegroundColor Green }
function Write-Note([string]$m) { Write-Host "  $m" }
function Write-Warn([string]$m) { Write-Host "  $m" -ForegroundColor Yellow }
function Ask([string]$question, [string]$default) {
  if ($Quiet) { return $default }
  $answer = Read-Host "  $question [$default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
  return $answer.Trim()
}
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Test-Writable([string]$dir) {
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $probe = Join-Path $dir ('.write-test-' + [guid]::NewGuid())
    Set-Content -Path $probe -Value 'x'
    Remove-Item $probe -Force
    return $true
  } catch { return $false }
}
function Finish([int]$code) {
  if ($Elevated -and -not $Quiet) { Write-Host ''; Read-Host 'Press Enter to close this window' | Out-Null }
  exit $code
}

# ---------------------------------------------------------------------------
# Version and source checks
# ---------------------------------------------------------------------------
$pkgPath = Join-Path $Source 'package.json'
if (-not (Test-Path (Join-Path $Source 'server.js')) -or -not (Test-Path $pkgPath)) {
  Write-Host "Can't find the Staffroom Gazette files next to the installer ($Source)." -ForegroundColor Red
  Write-Host 'Run Install.cmd from the unzipped release folder.'
  Finish 1
}
$Version = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version

Write-Host ''
Write-Host "  Staffroom Gazette $Version - installer" -ForegroundColor White
Write-Host '  ------------------------------------'

# ---------------------------------------------------------------------------
# Administrator rights (needed for Program Files, the startup task and the firewall)
# ---------------------------------------------------------------------------
$needAdmin = (-not $NoAutoStart) -or (-not $NoFirewall)
if (-not $needAdmin -and -not (Test-Admin)) {
  $needAdmin = -not ((Test-Writable $InstallDir) -and (Test-Writable $DataDir))
}
if ($needAdmin -and -not (Test-Admin)) {
  Write-Note 'Administrator permission is needed. Windows will ask you to allow it.'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  foreach ($k in $PSBoundParameters.Keys) {
    $v = $PSBoundParameters[$k]
    if ($v -is [switch]) { if ($v.IsPresent) { $argList += "-$k" } }
    else { $argList += "-$k"; $argList += "`"$v`"" }
  }
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
    exit $p.ExitCode
  } catch {
    Write-Host '  Administrator permission was not given, so nothing was installed.' -ForegroundColor Red
    exit 1
  }
}
$isAdmin = Test-Admin

try { Start-Transcript -Path (Join-Path $env:TEMP 'staffroom-gazette-install.log') -Force | Out-Null } catch { }

try {
  # -------------------------------------------------------------------------
  # Node.js
  # -------------------------------------------------------------------------
  Write-Step 'Checking for Node.js'
  function Find-Node {
    $candidates = @()
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    foreach ($c in $candidates) {
      if ($c -and (Test-Path $c)) {
        try {
          $raw = (& $c -v) | Select-Object -First 1
          return @{ Path = (Resolve-Path $c).Path; Version = [version]($raw.Trim().TrimStart('v')) }
        } catch { }
      }
    }
    return $null
  }
  $node = Find-Node
  if (-not $node -or $node.Version -lt $MinNode) {
    if ($node) { Write-Warn "Node.js $($node.Version) is installed, but $MinNode or newer is needed." }
    else { Write-Warn 'Node.js is not installed.' }
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
      $answer = Ask 'Install the current Node.js LTS now using winget? (Y/N)' 'Y'
      if ($answer -match '^[Yy]') {
        Write-Note 'Installing Node.js LTS (this can take a few minutes)...'
        & winget install --id OpenJS.NodeJS.LTS --exact --scope machine --silent --accept-package-agreements --accept-source-agreements
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        $node = Find-Node
      }
    }
    if (-not $node -or $node.Version -lt $MinNode) {
      Write-Host ''
      Write-Host "  Please install Node.js $MinNode or newer (the LTS version) from https://nodejs.org," -ForegroundColor Red
      Write-Host '  then run this installer again.' -ForegroundColor Red
      Finish 1
    }
  }
  Write-Ok "Node.js $($node.Version) found at $($node.Path)"

  # -------------------------------------------------------------------------
  # Existing install?
  # -------------------------------------------------------------------------
  $configPath = Join-Path $DataDir 'config.json'
  $config = $null
  if (Test-Path $configPath) {
    try { $config = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $config = $null }
  }
  $updating = [bool]$config
  if ($updating) { Write-Step "Updating the existing installation (your notices and accounts are kept)" }

  # Stop a running copy so its files can be replaced.
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  $serverPath = Join-Path $InstallDir 'server.js'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  # -------------------------------------------------------------------------
  # Port
  # -------------------------------------------------------------------------
  if ($Port -eq 0) {
    $default = if ($config -and $config.port) { [string]$config.port } else { '3000' }
    Write-Step 'Choosing a port'
    Write-Note 'Staff will open http://<this computer>:<port> in their browser.'
    while ($true) {
      $answer = Ask 'Port number' $default
      $parsed = 0
      if ([int]::TryParse($answer, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) { $Port = $parsed; break }
      Write-Warn 'Please enter a number between 1 and 65535.'
      if ($Quiet) { throw "Invalid port: $answer" }
    }
  }
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($inUse) {
    $owner = (Get-Process -Id ($inUse | Select-Object -First 1).OwningProcess -ErrorAction SilentlyContinue).ProcessName
    Write-Warn "Port $Port is already used by another program ($owner). The Gazette won't start until it's free, or until you reinstall with a different port."
  }

  # -------------------------------------------------------------------------
  # App files
  # -------------------------------------------------------------------------
  Write-Step "Copying files to $InstallDir"
  if (Test-Path $InstallDir) {
    $existing = Get-ChildItem -Force $InstallDir
    $ours = Test-Path (Join-Path $InstallDir 'server.js')
    if ($existing.Count -gt 0 -and -not $ours) {
      throw "$InstallDir already contains other files. Choose an empty folder with -InstallDir."
    }
    # Replace the app files (data lives elsewhere, in $DataDir).
    foreach ($item in 'server.js', 'package.json', 'README.md', 'LICENSE', 'lib', 'public', 'uninstall.ps1', 'Uninstall.cmd', 'Start in a window.cmd') {
      $p = Join-Path $InstallDir $item
      if (Test-Path $p) { Remove-Item -Recurse -Force $p }
    }
  }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  foreach ($item in 'server.js', 'package.json', 'README.md', 'LICENSE', 'lib', 'public') {
    $from = Join-Path $Source $item
    if (Test-Path $from) { Copy-Item -Recurse -Force $from $InstallDir }
  }
  Copy-Item -Force (Join-Path $PSScriptRoot 'uninstall.ps1') $InstallDir
  Get-ChildItem -Recurse -File $InstallDir | Unblock-File -ErrorAction SilentlyContinue

  $q = [char]34
  Set-Content -Encoding ASCII -Path (Join-Path $InstallDir 'Uninstall.cmd') -Value @(
    '@echo off',
    'title Uninstall Staffroom Gazette',
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $q%~dp0uninstall.ps1$q %*",
    'echo.',
    'pause'
  )
  Set-Content -Encoding ASCII -Path (Join-Path $InstallDir 'Start in a window.cmd') -Value @(
    '@echo off',
    'title Staffroom Gazette',
    'rem Runs the Gazette in this window (useful for troubleshooting). Close the window to stop it.',
    "$q$($node.Path)$q $q%~dp0server.js$q --config $q$configPath$q",
    'pause'
  )
  Write-Ok 'Files copied.'

  # -------------------------------------------------------------------------
  # Data folder and settings
  # -------------------------------------------------------------------------
  Write-Step "Preparing the data folder: $DataDir"
  $dataPath = Join-Path $DataDir 'data'
  $logPath = Join-Path $DataDir 'logs\gazette.log'
  New-Item -ItemType Directory -Force -Path $dataPath, (Split-Path $logPath) | Out-Null
  $settings = [ordered]@{}
  if ($config) { foreach ($prop in $config.PSObject.Properties) { $settings[$prop.Name] = $prop.Value } }
  $settings['port'] = $Port
  $settings['dataDir'] = $dataPath
  $settings['logFile'] = $logPath
  # Written without a byte-order mark so any tool can read it.
  [IO.File]::WriteAllText($configPath, ($settings | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  if ($isAdmin) {
    # Notices, uploads and password hashes: SYSTEM and Administrators only.
    & icacls.exe $DataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /Q | Out-Null
    Write-Ok 'Settings saved; folder restricted to administrators.'
  } else {
    Write-Ok 'Settings saved.'
  }

  # -------------------------------------------------------------------------
  # Run in the background at startup
  # -------------------------------------------------------------------------
  if (-not $NoAutoStart) {
    Write-Step 'Setting the Gazette to start automatically'
    $action = New-ScheduledTaskAction -Execute $node.Path -Argument "$q$serverPath$q --config $q$configPath$q" -WorkingDirectory $InstallDir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Description 'Runs the Staffroom Gazette noticeboard server.' `
      -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Ok 'It will now run in the background, including after restarts.'
  }

  # -------------------------------------------------------------------------
  # Firewall
  # -------------------------------------------------------------------------
  if (-not $NoFirewall) {
    Write-Step "Allowing port $Port through Windows Firewall (Domain and Private networks)"
    Get-NetFirewallRule -DisplayName $AppName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $AppName -Description 'Lets staff on the office network open Staffroom Gazette.' `
      -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Domain, Private | Out-Null
    Write-Ok 'Firewall rule added. (Public networks stay blocked.)'
  }

  # -------------------------------------------------------------------------
  # Shortcuts and Settings > Apps entry (administrators only)
  # -------------------------------------------------------------------------
  if ($isAdmin) {
    Write-Step 'Adding Start menu shortcuts'
    New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null
    Set-Content -Encoding ASCII -Path (Join-Path $StartMenu 'Staffroom Gazette.url') -Value @('[InternetShortcut]', "URL=http://localhost:$Port/")
    Set-Content -Encoding ASCII -Path (Join-Path $StartMenu 'Staffroom Gazette TV display.url') -Value @('[InternetShortcut]', "URL=http://localhost:$Port/tv")
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut((Join-Path $StartMenu 'Uninstall Staffroom Gazette.lnk'))
    $lnk.TargetPath = Join-Path $InstallDir 'Uninstall.cmd'
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Save()
    $log = $shell.CreateShortcut((Join-Path $StartMenu 'Staffroom Gazette log.lnk'))
    $log.TargetPath = 'notepad.exe'
    $log.Arguments = "$q$logPath$q"
    $log.Save()

    $size = [int]((Get-ChildItem -Recurse -File $InstallDir | Measure-Object Length -Sum).Sum / 1KB)
    New-Item -Path $RegKey -Force | Out-Null
    $values = @{
      DisplayName = $AppName; DisplayVersion = $Version; Publisher = 'Staffroom Gazette'
      InstallLocation = $InstallDir; DisplayIcon = $node.Path
      UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $q$InstallDir\uninstall.ps1$q"
      URLInfoAbout = 'https://github.com/riku593/staffroom-gazette'
    }
    foreach ($k in $values.Keys) { New-ItemProperty -Path $RegKey -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
    foreach ($k in 'NoModify', 'NoRepair') { New-ItemProperty -Path $RegKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
    New-ItemProperty -Path $RegKey -Name 'EstimatedSize' -Value $size -PropertyType DWord -Force | Out-Null
    Write-Ok 'Shortcuts added; listed in Settings > Apps.'
  }

  # -------------------------------------------------------------------------
  # Check it's running
  # -------------------------------------------------------------------------
  $url = "http://localhost:$Port/"
  $running = $false
  if (-not $NoAutoStart) {
    Write-Step 'Waiting for the Gazette to start'
    for ($i = 0; $i -lt 30 -and -not $running; $i++) {
      Start-Sleep -Milliseconds 700
      try { $running = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$url`api/status").StatusCode -eq 200 } catch { }
    }
    if ($running) { Write-Ok 'It is running.' }
    else {
      Write-Warn "It didn't respond yet. The log may say why: $logPath"
      if (Test-Path $logPath) { Get-Content $logPath -Tail 8 | ForEach-Object { Write-Host "    $_" } }
    }
  }

  # -------------------------------------------------------------------------
  # Done
  # -------------------------------------------------------------------------
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress)
  Write-Host ''
  Write-Host '  ------------------------------------' -ForegroundColor Green
  if ($updating) { Write-Host "  Staffroom Gazette updated to $Version." -ForegroundColor Green }
  else { Write-Host "  Staffroom Gazette $Version is installed." -ForegroundColor Green }
  Write-Host '  ------------------------------------' -ForegroundColor Green
  Write-Host "  On this computer:  $url"
  foreach ($ip in $ips) { Write-Host "  On the network:    http://${ip}:$Port/" }
  Write-Host "  TV display:        add /tv to either address"
  Write-Host "  App files:         $InstallDir"
  Write-Host "  Notices & uploads: $dataPath  (back up this folder)"
  Write-Host "  Log:               $logPath"
  if ($NoAutoStart) { Write-Host "  To run it:         $(Join-Path $InstallDir 'Start in a window.cmd')" }
  if (-not $updating) {
    Write-Host ''
    Write-Host '  Next: open the page on THIS computer and create the first HR admin account.' -ForegroundColor White
  }
  if ($running -and -not $NoBrowser -and -not $Quiet) { Start-Process $url }
  try { Stop-Transcript | Out-Null } catch { }
  Finish 0
} catch {
  Write-Host ''
  Write-Host "  Installation failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Details were saved to $(Join-Path $env:TEMP 'staffroom-gazette-install.log')"
  try { Stop-Transcript | Out-Null } catch { }
  Finish 1
}
