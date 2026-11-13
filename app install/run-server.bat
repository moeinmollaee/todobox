@echo off
setlocal
cd /d "%~dp0.."
set "PORT=8080"
set "TODOBOX_PORT=%PORT%"

REM Already our mail bridge?
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/mail/health' -UseBasicParsing -TimeoutSec 2; if ($r.Content -match '\"ok\"\s*:\s*true') { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel%==0 (
  echo TodoBox Mail bridge already running on port %PORT%.
  exit /b 0
)

REM Something else on the port — free it
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo Port %PORT% is busy with another process. Stopping it...
  call "%~dp0stop-server.bat"
  timeout /t 1 /nobreak >nul
)

if not exist "vendor\sql-wasm.js" (
  call install.bat
)

if not exist "node_modules\imapflow" (
  call npm install
)

echo Starting TodoBox + Mail Bridge at http://127.0.0.1:%PORT%/app.html
echo Keep this window open while using Mail.
echo.
node mail-bridge\server.mjs
