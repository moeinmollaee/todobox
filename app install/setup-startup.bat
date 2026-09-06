@echo off
setlocal
if /I "%~1"=="disable" goto DISABLE
if /I "%~1"=="open" goto OPEN
if /I "%~1"=="enable" goto ENABLE
exit /b 1

:ENABLE
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-startup-shortcut.ps1" -Mode enable
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TodoBox.lnk" (
  echo Added to Windows Startup ^(server only, hidden^).
  exit /b 0
)
echo Could not add to Startup.
exit /b 1

:OPEN
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-startup-shortcut.ps1" -Mode open
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TodoBox.lnk" (
  echo Added to Windows Startup ^(server + open TodoBox^).
  exit /b 0
)
echo Could not add to Startup.
exit /b 1

:DISABLE
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-startup-shortcut.ps1" -Mode disable
echo Removed from Windows Startup.
exit /b 0
