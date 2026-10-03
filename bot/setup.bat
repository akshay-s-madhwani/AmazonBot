@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"
title Bot setup

echo.
echo  ===========================================================
echo   Bot machine setup
echo  ===========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js is not installed.
  echo.
  echo      Install the LTS build from https://nodejs.org/ ^(version 20.6 or
  echo      newer^), then run this script again.
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set "NODE_V=%%v"
for /f "tokens=1 delims=." %%a in ("!NODE_V:v=!") do set "NODE_MAJOR=%%a"
if !NODE_MAJOR! LSS 20 (
  echo  [X] Node.js !NODE_V! is too old -- 20.6 or newer is required.
  echo      Update from https://nodejs.org/ and run this script again.
  echo.
  pause
  exit /b 1
)
echo  [ok] Node.js !NODE_V!

set "MASTER_URL=%~1"

if "!MASTER_URL!"=="" (
  if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
      if /i "%%a"=="MASTER_URL" set "MASTER_URL=%%b"
    )
  )
)

if "!MASTER_URL!"=="" (
  echo.
  set /p "MASTER_URL=  Control panel URL: "
)

if "!MASTER_URL!"=="" (
  echo  [X] No control panel URL given -- nothing to join. Aborting.
  pause
  exit /b 1
)

if "!MASTER_URL:~-1!"=="/" set "MASTER_URL=!MASTER_URL:~0,-1!"
echo  [ok] control panel: !MASTER_URL!

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo  [ok] created .env from .env.example -- fill in the account details later
  ) else (
    type nul > ".env"
    echo  [ok] created an empty .env
  )
)

findstr /b /i /c:"MASTER_URL=" ".env" >nul 2>nul
if errorlevel 1 (
  >>".env" echo.
  >>".env" echo # Control panel this machine reports to ^(written by setup.bat^).
  >>".env" echo MASTER_URL=!MASTER_URL!
  echo  [ok] wrote MASTER_URL into .env
)

echo.
echo  Installing dependencies ^(this takes a few minutes the first time^)...
echo.

call :build_pkg "..\packages\contracts" "shared contracts" || goto :failed
call :build_pkg "..\packages\transport" "transport"        || goto :failed

echo  --- bot ---
call npm install --no-audit --no-fund || goto :failed
call npm run build || goto :failed
echo  [ok] bot built

echo.
echo  --- ShardX browser engine ---
node dist\install-browser.js || goto :failed

if not exist "browser-profiles" mkdir "browser-profiles"
echo  [ok] profile store: %CD%\browser-profiles

> "start.bat" echo @echo off
>> "start.bat" echo cd /d "%%~dp0"
>> "start.bat" echo title Bot
>> "start.bat" echo start "" http://127.0.0.1:7800
>> "start.bat" echo node dist\manager.js
>> "start.bat" echo pause
echo  [ok] created start.bat for future starts

echo.
echo  ===========================================================
echo   Setup complete. Starting the bot.
echo.
echo   It will print a SHORT ID below, and open its own console
echo   at http://127.0.0.1:7800 which shows the same id.
echo.
echo   In the control panel, go to Bot Grid and approve the
echo   machine with that id. Until then the bot waits -- normal.
echo  ===========================================================
echo.

set "MASTER_URL=!MASTER_URL!"
start "" http://127.0.0.1:7800
node dist\manager.js
echo.
echo  The bot has stopped. Run start.bat to start it again.
pause
exit /b 0

:build_pkg
echo  --- %~2 ---
pushd "%~1" || exit /b 1
call npm install --no-audit --no-fund || (popd & exit /b 1)
call npm run build || (popd & exit /b 1)
popd
echo  [ok] %~2 built
exit /b 0

:failed
echo.
echo  [X] Setup failed at the step above. Fix the error and run setup.bat again.
echo.
pause
exit /b 1
