@echo off
title Staffroom Gazette installer
rem Double-click to install or update Staffroom Gazette on this computer.
rem Options can be added, e.g.:  Install.cmd -Port 8080
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
echo.
pause
