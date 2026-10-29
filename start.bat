@echo off
title AI Huddle
cd /d "%~dp0"
if not exist node_modules (
  echo first run, installing dependencies. this takes a minute...
  call npm install
)
call npm start
