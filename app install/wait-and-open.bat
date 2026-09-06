@echo off
setlocal
set "PORT=8080"

for /L %%i in (1,1,45) do (
  netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
  if not errorlevel 1 (
    call "%~dp0open-todobox.bat"
    exit /b 0
  )
  ping -n 2 127.0.0.1 >nul
)

call "%~dp0open-todobox.bat"
exit /b 0
