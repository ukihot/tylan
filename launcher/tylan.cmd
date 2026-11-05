@echo off
rem Starts the tylan editor (tylan.ps1 next to this file). Closing this window stops it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tylan.ps1"
if errorlevel 1 pause
