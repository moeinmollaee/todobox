@echo off
setlocal
cd /d "%~dp0.."
set "PORT=8080"

netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 exit /b 0

if not exist "vendor\sql-wasm.js" (
  call install.bat
)

echo Starting TodoBox PWA at http://localhost:%PORT%/app.html
echo Close this window to stop the server.
echo.
npx --yes serve -l %PORT% .
