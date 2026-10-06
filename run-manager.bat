@echo off
cd /d "%~dp0bot"
title Bot manager
start "" http://127.0.0.1:7800
node dist\manager.js
pause
