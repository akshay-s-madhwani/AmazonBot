@echo off
if defined NVM_SYMLINK set "PATH=%NVM_SYMLINK%;%PATH%"
cd /d "%~dp0"
if not defined MANAGER_PORT set "MANAGER_PORT=7800"
curl --fail --silent --show-error --max-time 15 -X POST http://127.0.0.1:%MANAGER_PORT%/fleet/stop >nul
if errorlevel 1 echo [!] Could not stop slots cleanly; check the manager logs.
call pm2 stop bot-manager || exit /b 1
call pm2 save
