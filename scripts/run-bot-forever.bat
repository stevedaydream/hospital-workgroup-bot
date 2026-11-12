@echo off
rem Keeps the bot running: starts it, and if it ever exits, starts it again after 10 s.
rem Used by the HospitalBot shortcut in the Startup folder (through start-bot-hidden.vbs).
rem To stop it for good, create data\bot.stop, then stop the node process.
rem If something else already serves port 3000 (Port Monitor, a manual npm start),
rem it waits instead of starting a second copy.
cd /d "%~dp0.."
:loop
if exist data\bot.stop goto stopped
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul
if not errorlevel 1 goto wait
echo [Watchdog] %date% %time% starting bot. >> data\bot.log
call npm start >> data\bot.log 2>&1
echo [Watchdog] %date% %time% bot exited with code %errorlevel%, restarting in 10 s. >> data\bot.log
:wait
timeout /t 10 /nobreak >nul
goto loop
:stopped
echo [Watchdog] %date% %time% data\bot.stop found, not restarting. >> data\bot.log
exit /b 0
