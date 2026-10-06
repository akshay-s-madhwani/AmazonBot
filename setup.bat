@echo off
setlocal enabledelayedexpansion

rem Bot machine setup. Lives at the AmazonBot root, next to bot\ and packages\,
rem and works from a fresh copy: no node_modules, no dist anywhere.
rem   setup.bat                        asks for the control panel URL
rem   setup.bat http://1.2.3.4         or pass it in

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

rem ---- the shared packages (a git submodule) ---------------------------------
if not exist "packages\contracts\package.json" (
  if exist ".git" (
    where git >nul 2>nul
    if not errorlevel 1 (
      echo  ... fetching the shared packages ^(git submodule^)
      git submodule update --init --recursive
    )
  )
)
if not exist "packages\contracts\package.json" (
  echo  [X] The packages folder is missing or empty.
  echo.
  echo      Clone with:  git clone --recurse-submodules ^<repo^>
  echo      or run:      git submodule update --init
  echo      or copy the packages folder next to bot\ and run this again.
  echo.
  pause
  exit /b 1
)
echo  [ok] shared packages present

rem ---- control panel URL -> bot\.env --------------------------------------------
set "MASTER_URL=%~1"

if "!MASTER_URL!"=="" (
  if exist "bot\.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("bot\.env") do (
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

if not exist "bot\.env" (
  if exist "bot\.env.example" (
    copy /y "bot\.env.example" "bot\.env" >nul
    echo  [ok] created bot\.env from bot\.env.example
  ) else (
    type nul > "bot\.env"
    echo  [ok] created an empty bot\.env
  )
)

rem Replace any MASTER_URL already there, so re-running with a new URL sticks.
findstr /v /b /i /c:"MASTER_URL=" "bot\.env" > "bot\.env.tmp"
>>"bot\.env.tmp" echo MASTER_URL=!MASTER_URL!
move /y "bot\.env.tmp" "bot\.env" >nul
echo  [ok] MASTER_URL written to bot\.env

rem ---- install + build, in dependency order -------------------------------------
echo.
echo  Installing dependencies ^(this takes a few minutes the first time^)...
echo.

call :build_pkg "packages\contracts" "shared contracts" || goto :failed
call :build_pkg "packages\transport" "transport"        || goto :failed
call :build_pkg "bot"                "bot"              || goto :failed

echo.
echo  --- ShardX browser engine ---
pushd "bot" || goto :failed
node dist\install-browser.js || (popd & goto :failed)
if not exist "browser-profiles" mkdir "browser-profiles"
echo  [ok] profile store: %CD%\browser-profiles
popd

> "start.bat" echo @echo off
>> "start.bat" echo cd /d "%%~dp0bot"
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
echo   In the control panel, open Machines and approve the
echo   machine with that id. Until then the bot waits -- normal.
echo  ===========================================================
echo.

start "" http://127.0.0.1:7800
cd /d "%~dp0bot"
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
