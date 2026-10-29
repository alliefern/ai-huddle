@echo off
title AI Huddle
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies. This takes a minute...
  call npm install
)
call npm start
