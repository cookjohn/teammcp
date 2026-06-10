@echo off
REM tmcp.cmd — cmd.exe wrapper around tmcp.ps1
REM Prefer PowerShell 7 (pwsh) when available; fall back to Windows PowerShell 5.1.
where pwsh >nul 2>nul
if %errorlevel% == 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tmcp.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tmcp.ps1" %*
)
