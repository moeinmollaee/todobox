@echo off
setlocal
set "CFG=%~dp0pwa-settings.ini"

echo.
echo  TodoBox PWA - Startup settings
echo  ==============================
echo.

if exist "%CFG%" (
  findstr /I "startup=2" "%CFG%" >nul 2>&1
  if %errorlevel%==0 (
    echo  Current: Start with Windows ^(server + open TodoBox^)
    goto MENU
  )
  findstr /I "startup=1" "%CFG%" >nul 2>&1
  if %errorlevel%==0 (
    echo  Current: Start with Windows ^(server only^)
    goto MENU
  )
  echo  Current: Manual ^(run run.bat each time^)
  goto MENU
) else (
  echo  Not configured yet. Run run.bat first.
  pause
  exit /b 0
)

:MENU
echo.
echo  [1] Start with Windows ^(server only^)
echo  [2] Manual each time
echo  [3] Start with Windows ^(server + open TodoBox^)
echo  [4] Cancel
echo.
choice /C 1234 /N /M "Choose: "

if errorlevel 4 exit /b 0
if errorlevel 3 goto SET_STARTUP_OPEN
if errorlevel 2 goto SET_MANUAL
if errorlevel 1 goto SET_STARTUP

:SET_STARTUP
(echo startup=1)>"%CFG%"
(echo asked=1)>>"%CFG%"
call "%~dp0setup-startup.bat" enable
goto DONE

:SET_STARTUP_OPEN
(echo startup=2)>"%CFG%"
(echo asked=1)>>"%CFG%"
call "%~dp0setup-startup.bat" open
goto DONE

:SET_MANUAL
(echo startup=0)>"%CFG%"
(echo asked=1)>>"%CFG%"
call "%~dp0setup-startup.bat" disable
goto DONE

:DONE
echo.
pause
