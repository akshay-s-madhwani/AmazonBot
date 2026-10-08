@echo off
rem Kills this bot folder's leftover browsers, slots and runners.
rem   cleanup.bat           orphans (or everything when the manager is not running)
rem   cleanup.bat --all     everything, live runs included
rem   cleanup.bat --dry-run list only
cd /d "%~dp0bot"
node dist\cleanup.js %*
pause
