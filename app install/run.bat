@echo off
setlocal
cd /d "%~dp0.."
set "CFG=%~dp0pwa-settings.ini"
set "PORT=8080"
set "MODE=0"

if not exist "vendor\sql-wasm.js" (
  echo Running install first...
  call install.bat
)

if not exist "%CFG%" goto FIRST_RUN
findstr /R /C:"^startup=0$" /C:"^startup=1$" /C:"^startup=2$" "%CFG%" >nul 2>&1
if errorlevel 1 goto FIRST_RUN
call :READ_MODE
goto START

:FIRST_RUN
echo.
echo  TodoBox PWA - first run
echo  =======================
echo.
echo  [1] Start with Windows       ^(server only, hidden^)
echo  [2] Manual each time         ^(run this file when needed^)
echo  [3] Start with Windows       ^(server + open TodoBox^)
echo.
choice /C 123 /N /M "Choose 1, 2 or 3: "

if errorlevel 3 goto SAVE_STARTUP_OPEN
if errorlevel 2 goto SAVE_MANUAL
if errorlevel 1 goto SAVE_STARTUP

:SAVE_STARTUP
(echo startup=1)>"%CFG%"
(echo asked=1)>>"%CFG%"
set "MODE=1"
call "%~dp0setup-startup.bat" enable
echo.
goto START

:SAVE_STARTUP_OPEN
(echo startup=2)>"%CFG%"
(echo asked=1)>>"%CFG%"
set "MODE=2"
call "%~dp0setup-startup.bat" open
echo.
goto START

:SAVE_MANUAL
(echo startup=0)>"%CFG%"
(echo asked=1)>>"%CFG%"
set "MODE=0"
call "%~dp0setup-startup.bat" disable
echo.
goto START

:START
REM If mail bridge is already healthy, just open the app
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/api/mail/health' -UseBasicParsing -TimeoutSec 2; if ($r.Content -match '\"ok\"\s*:\s*true') { exit 0 } else { exit 1 } } catch { exit 1 }"
if %errorlevel%==0 (
  call "%~dp0open-todobox.bat"
  exit /b 0
)

REM Port busy but not our mail bridge — replace it
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo Replacing process on port %PORT% with TodoBox Mail bridge...
  call "%~dp0stop-server.bat"
  timeout /t 1 /nobreak >nul
)

if "%MODE%"=="0" goto RUN_MANUAL
call "%~dp0run-server-hidden.bat"
call "%~dp0wait-and-open.bat"
exit /b 0

:RUN_MANUAL
start "" "%~dp0wait-and-open.bat"
call "%~dp0run-server.bat"
exit /b 0

:READ_MODE
set "MODE=0"
findstr /I "startup=1" "%CFG%" >nul 2>&1 && set "MODE=1"
findstr /I "startup=2" "%CFG%" >nul 2>&1 && set "MODE=2"
exit /b 0
