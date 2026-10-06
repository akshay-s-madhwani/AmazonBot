@echo off
rem Stops the slots, then the manager. Browsers stay open by design.
curl -s -X POST http://127.0.0.1:7800/fleet/stop >nul 2>nul
timeout /t 1 /nobreak >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":7800 .*LISTENING"') do taskkill /f /pid %%p
pause
