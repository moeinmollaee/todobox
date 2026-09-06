@echo off
cd /d "%~dp0.."
call "%~dp0run-server-hidden.bat"
if /I "%~1"=="open" call "%~dp0wait-and-open.bat"
exit /b 0
