@echo off
setlocal
cd /d "%~dp0.."
set "PORT=8080"

netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 exit /b 0

if not exist "vendor\sql-wasm.js" call install.bat

wscript.exe //B "%~dp0TodoBox-tray-launch.vbs"
exit /b 0
