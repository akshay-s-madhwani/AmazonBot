@echo off
if defined NVM_SYMLINK set "PATH=%NVM_SYMLINK%;%PATH%"
cd /d "%~dp0"
if not exist deploy.env (
  echo [X] Run setup.bat first to configure the deployment webhook.
  exit /b 1
)
call pm2 start ecosystem.config.cjs || exit /b 1
call pm2 save || exit /b 1
start "" http://127.0.0.1:7800
