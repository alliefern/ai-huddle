@echo off
title build AI Huddle
cd /d "%~dp0"
echo installing dependencies. the first time takes a minute...
call npm install
if errorlevel 1 goto fail
echo building the installer and the portable app...
call npm run dist
if errorlevel 1 goto fail
echo.
echo done. your files are in the "dist" folder:
echo   AI-Huddle-Setup.exe     (the installer, you can send this to friends)
echo   AI-Huddle-Portable.exe  (one file, nothing to install)
start "" "%~dp0dist"
pause
exit /b 0
:fail
echo.
echo something failed. scroll up for the reason, or send me the error text.
pause
exit /b 1
