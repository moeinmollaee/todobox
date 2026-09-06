@echo off
setlocal
set "PORT=8080"
set "FOUND=0"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  taskkill /PID %%a /F >nul 2>&1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*TodoBox-tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

if "%FOUND%"=="1" (
  echo TodoBox stopped ^(server + tray icon^).
) else (
  echo No TodoBox server was running on port %PORT%.
)
pause
