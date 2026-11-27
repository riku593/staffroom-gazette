<#
.SYNOPSIS
  Removes Staffroom Gazette from this computer.

.DESCRIPTION
  Stops the Gazette and removes its startup task, firewall rule, shortcuts,
  Settings > Apps entry and program files.
  Notices, accounts and uploaded files are KEPT unless you choose to delete them
  (or pass -RemoveData), so you can reinstall later without losing anything.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$DataDir = (Join-Path $env:ProgramData 'Staffroom Gazette'),
  [switch]$RemoveData,
  [switch]$Quiet,
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$AppName = 'Staffroom Gazette'
$TaskName = 'Staffroom Gazette'
$RegKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StaffroomGazette'
$StartMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Staffroom Gazette'

function Write-Ok([string]$m) { Write-Host "  $m" -ForegroundColor Green }
function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Finish([int]$code) {
  if ($Elevated -and -not $Quiet) { Write-Host ''; Read-Host 'Press Enter to close this window' | Out-Null }
  exit $code
}
function Test-OurInstall([string]$dir) {
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path (Join-Path $dir 'server.js')) -or -not (Test-Path $pkg)) { return $false }
  try { return (Get-Content $pkg -Raw | ConvertFrom-Json).name -eq 'staffroom-gazette' } catch { return $false }
}

# Where is it installed?
if (-not $InstallDir) {
  $reg = Get-ItemProperty -Path $RegKey -ErrorAction SilentlyContinue
  if ($reg -and $reg.InstallLocation) { $InstallDir = $reg.InstallLocation }
  elseif (Test-OurInstall $PSScriptRoot) { $InstallDir = $PSScriptRoot }
  else { $InstallDir = Join-Path $env:ProgramFiles 'Staffroom Gazette' }
}

Write-Host ''
Write-Host '  Uninstall Staffroom Gazette' -ForegroundColor White
Write-Host '  ---------------------------'

# Administrator rights are only needed for the parts that exist.
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$rule = Get-NetFirewallRule -DisplayName $AppName -ErrorAction SilentlyContinue
$needAdmin = $task -or $rule -or (Test-Path $RegKey) -or (Test-Path $StartMenu) -or
  $InstallDir.StartsWith($env:ProgramFiles, [StringComparison]::OrdinalIgnoreCase) -or
  $DataDir.StartsWith($env:ProgramData, [StringComparison]::OrdinalIgnoreCase)
if ($needAdmin -and -not (Test-Admin)) {
  Write-Host '  Administrator permission is needed. Windows will ask you to allow it.'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-InstallDir', "`"$InstallDir`"")
  foreach ($k in $PSBoundParameters.Keys) {
    if ($k -eq 'InstallDir') { continue }
    $v = $PSBoundParameters[$k]
    if ($v -is [switch]) { if ($v.IsPresent) { $argList += "-$k" } }
    else { $argList += "-$k"; $argList += "`"$v`"" }
  }
  try {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
    exit $p.ExitCode
  } catch {
    Write-Host '  Administrator permission was not given, so nothing was removed.' -ForegroundColor Red
    exit 1
  }
}

try {
  if (-not $Quiet -and -not $RemoveData) {
    $answer = Read-Host '  Remove Staffroom Gazette from this computer? (Y/N)'
    if ($answer -notmatch '^[Yy]') { Write-Host '  Nothing was removed.'; Finish 0 }
  }

  # Stop it
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Ok 'Startup task removed.'
  }
  $serverPath = Join-Path $InstallDir 'server.js'
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($serverPath) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  if ($rule) { $rule | Remove-NetFirewallRule; Write-Ok 'Firewall rule removed.' }
  if (Test-Path $StartMenu) { Remove-Item -Recurse -Force $StartMenu; Write-Ok 'Start menu shortcuts removed.' }
  if (Test-Path $RegKey) { Remove-Item -Recurse -Force $RegKey; Write-Ok 'Removed from Settings > Apps.' }

  # Program files (only if the folder really is a Gazette install)
  Set-Location $env:TEMP
  if (Test-Path $InstallDir) {
    if (Test-OurInstall $InstallDir) {
      Start-Sleep -Milliseconds 500 # let the stopped process release its files
      Remove-Item -Recurse -Force $InstallDir
      Write-Ok "Program files removed ($InstallDir)."
    } else {
      Write-Host "  $InstallDir doesn't look like a Staffroom Gazette install, so it was left alone." -ForegroundColor Yellow
    }
  }

  # Data: kept unless asked
  if (Test-Path $DataDir) {
    $delete = [bool]$RemoveData
    if (-not $delete -and -not $Quiet) {
      Write-Host ''
      Write-Host "  Your notices, HR accounts and uploaded files are in $DataDir" -ForegroundColor White
      $answer = Read-Host '  Type DELETE to erase them permanently, or press Enter to keep them'
      $delete = $answer -ceq 'DELETE'
    }
    if ($delete) {
      Remove-Item -Recurse -Force $DataDir
      Write-Ok 'Notices, accounts and uploads deleted.'
    } else {
      Write-Host "  Kept your data in $DataDir. Reinstalling will pick it up again."
    }
  }

  Write-Host ''
  Write-Host '  Staffroom Gazette has been uninstalled.' -ForegroundColor Green
  Finish 0
} catch {
  Write-Host "  Uninstall failed: $($_.Exception.Message)" -ForegroundColor Red
  Finish 1
}
