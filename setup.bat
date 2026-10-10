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

rem ---- Node.js 22+ -- installed through nvm for Windows when missing/too old --
rem An nvm install from an earlier run may not be on this window's PATH yet.
call :find_nvm
if defined NVM_SYMLINK if exist "!NVM_SYMLINK!\node.exe" set "PATH=!NVM_SYMLINK!;!PATH!"

call :check_node
if errorlevel 1 (
  call :install_node || goto :failed
  call :check_node
  if errorlevel 1 (
    echo  [X] Node.js is still not usable after the install.
    echo      Close this window and run setup.bat again.
    goto :failed
  )
)
echo  [ok] Node.js !NODE_V!

rem Webhook updates require Git even when the packages folder already exists.
where git >nul 2>nul
if errorlevel 1 call :install_git
where git >nul 2>nul || goto :failed
git rev-parse --is-inside-work-tree >nul 2>nul || goto :failed

rem ---- the shared packages (a git submodule) ---------------------------------
if not exist "packages\contracts\package.json" (
  if exist ".git" (
    where git >nul 2>nul
    if errorlevel 1 call :install_git
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

rem ---- this machine's node id -> bot\.node-id ----------------------------------
rem Kept without asking when this machine is already approved as bot\.node-id
rem (scripts\approved-node-id.mjs). Otherwise asked; Enter takes the machine
rem name. A copied folder's approval for another id is discarded by the bot at
rem start, and an id already in use is rejected by the master.
set "NODE_ID_APPROVED="
for /f "delims=" %%i in ('node scripts\approved-node-id.mjs 2^>nul') do set "NODE_ID_APPROVED=%%i"
if defined NODE_ID_APPROVED (
  echo  [ok] node id: !NODE_ID_APPROVED! ^(already approved^)
  goto :node_id_done
)
set "NODE_ID_CURRENT="
if exist "bot\.node-id" set /p NODE_ID_CURRENT=<"bot\.node-id"
if defined NODE_ID_CURRENT echo  current node id: !NODE_ID_CURRENT!
for /f "delims=" %%i in ('node -p "process.env.COMPUTERNAME.toLowerCase()"') do set "NODE_ID_DEFAULT=%%i"

:ask_node_id
set "NODE_ID_IN="
echo.
set /p "NODE_ID_IN=  Node id [!NODE_ID_DEFAULT!]: "
if "!NODE_ID_IN!"=="" set "NODE_ID_IN=!NODE_ID_DEFAULT!"
node -e "process.exit(/^[A-Za-z0-9_-]{1,64}$/.test(process.env.NODE_ID_IN)?0:1)"
if errorlevel 1 (
  echo  [X] Use letters, digits, - or _ only.
  goto :ask_node_id
)
> "bot\.node-id" echo !NODE_ID_IN!
echo  [ok] node id: !NODE_ID_IN!
:node_id_done

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

call npm install --global pm2@6.0.14 --no-audit --no-fund || goto :failed
rem Creates/validates deploy.env, prompts for missing credentials, and registers startup.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-startup.ps1 || goto :failed
> "start.bat" echo @echo off
>> "start.bat" echo call "%%~dp0run-manager.bat"
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
call pm2 start ecosystem.config.cjs || goto :failed
call pm2 save || goto :failed
echo.
echo  The bot is managed by PM2. Use stop-manager.bat to stop it.
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

rem ---- Node.js helpers --------------------------------------------------------

rem errorlevel 0 when node is on PATH and is 22 or newer; NODE_V = its version.
:check_node
set "NODE_V="
where node >nul 2>nul || exit /b 1
for /f "tokens=*" %%v in ('node -v') do set "NODE_V=%%v"
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" || exit /b 1
exit /b 0

rem Sets NVM_HOME / NVM_SYMLINK (env, then registry, then nvm's defaults) and
rem NVM_EXE when nvm.exe is actually there.
:find_nvm
set "NVM_EXE="
if not defined NVM_HOME call :reg_env NVM_HOME
if not defined NVM_SYMLINK call :reg_env NVM_SYMLINK
if not defined NVM_HOME set "NVM_HOME=%APPDATA%\nvm"
if not defined NVM_SYMLINK (
  if exist "C:\nvm4w" (
    set "NVM_SYMLINK=C:\nvm4w\nodejs"
  ) else (
    set "NVM_SYMLINK=%ProgramFiles%\nodejs"
  )
)
if exist "!NVM_HOME!\nvm.exe" set "NVM_EXE=!NVM_HOME!\nvm.exe"
exit /b 0

rem Reads %1 from the machine, then the user, environment in the registry --
rem an install in this window is not in this window's environment yet.
:reg_env
for %%k in ("HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "HKCU\Environment") do (
  if not defined %1 (
    for /f "tokens=2,*" %%a in ('reg query %%k /v %1 2^>nul ^| find "REG_"') do set "%1=%%b"
  )
)
exit /b 0

:install_node
echo.
if defined NODE_V (
  echo  ... Node.js !NODE_V! is too old -- installing the current LTS through nvm.
) else (
  echo  ... Node.js is not installed -- installing the current LTS through nvm.
)
call :find_nvm
if defined NVM_EXE goto :have_nvm
rem Pinned: 1.2.2 is the last nvm-setup.exe (Inno Setup, so /VERYSILENT works);
rem 2.x renamed its installers and "latest" no longer has this file.
echo  ... downloading nvm for Windows
call :download "https://github.com/coreybutler/nvm-windows/releases/download/1.2.2/nvm-setup.exe" "%TEMP%\nvm-setup.exe"
if errorlevel 1 (
  echo  [X] Could not download nvm. Check the internet connection.
  exit /b 1
)
echo  ... installing nvm ^(approve the Windows prompt^)
start "" /wait "%TEMP%\nvm-setup.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-
set "NVM_HOME="
set "NVM_SYMLINK="
call :find_nvm
if not defined NVM_EXE (
  echo  [X] nvm did not install.
  exit /b 1
)
echo  [ok] nvm installed

:have_nvm
set "LTS_V="
call :download "https://nodejs.org/dist/index.json" "%TEMP%\node-index.json"
if not errorlevel 1 (
  for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "((Get-Content -Raw (Join-Path $env:TEMP 'node-index.json') | ConvertFrom-Json) | Where-Object { $_.lts } | Select-Object -First 1).version.TrimStart('v')" 2^>nul`) do set "LTS_V=%%v"
)
if not defined LTS_V set "LTS_V=lts"
echo  ... installing Node.js !LTS_V!
"!NVM_EXE!" install !LTS_V!
echo  ... switching to Node.js !LTS_V! ^(approve the Windows prompt^)
"!NVM_EXE!" use !LTS_V!
set "PATH=!NVM_SYMLINK!;!NVM_HOME!;!PATH!"
exit /b 0

rem Downloads %1 to %2. curl.exe (in Windows 10 1803+) with retries first;
rem PowerShell 5.1's Invoke-WebRequest drops GitHub's redirect on some networks.
:download
del /q "%~2" >nul 2>nul
where curl.exe >nul 2>nul && (
  curl.exe -fL --retry 4 --retry-delay 2 --connect-timeout 30 -sS -o "%~2" "%~1" && exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing '%~1' -OutFile '%~2'" && exit /b 0
exit /b 1

rem Git for webhook updates and the packages submodule. Needs winget.
:install_git
where winget >nul 2>nul || exit /b 0
echo  ... installing Git ^(approve the Windows prompt^)
winget install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%ProgramFiles%\Git\cmd;!PATH!"
exit /b 0

:failed
echo.
echo  [X] Setup failed at the step above. Fix the error and run setup.bat again.
echo.
pause
exit /b 1
