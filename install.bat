@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo ========================================
echo   TodoBox - Setup
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo         Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed.
  pause
  exit /b 1
)
echo.

echo [2/3] Copying sql.js into vendor/...
call npm run vendor
if errorlevel 1 (
  echo [ERROR] npm run vendor failed.
  pause
  exit /b 1
)
echo.

echo [3/3] Building sounds/index.json...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-sounds-index.ps1"
if errorlevel 1 (
  echo [WARN] Could not build sounds index.
)
echo.

echo ========================================
echo   Setup complete
echo ========================================
echo.
echo Next: chrome://extensions -^> Developer mode -^> Load unpacked
echo Folder: %~dp0
echo.
pause
exit /b 0
