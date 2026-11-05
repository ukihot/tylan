@echo off
rem Starts the tylan editor (tylan.ps1 next to this file) without a console window.
rem It stops by itself a few minutes after the editor window is closed.
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tylan.ps1"
