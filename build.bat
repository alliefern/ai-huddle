@echo off
title Build AI Huddle
cd /d "%~dp0"
echo Installing dependencies (first time takes a minute)...
call npm install
if errorlevel 1 goto fail
echo Building the installer and portable app...
call npm run dist
if errorlevel 1 goto fail
echo.
echo Done. Your files are in the "dist" folder:
echo   AI-Huddle-Setup.exe     (installer, send this to friends)
echo   AI-Huddle-Portable.exe  (single file, no install)
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo Something failed. Scroll up to see why, or send me the error text.
pause
exit /b 1
