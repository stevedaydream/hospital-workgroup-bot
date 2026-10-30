@echo off
rem Runs the bot until it exits, logging to data\bot.log.
rem Used by Port Monitor's launcher and the HospitalBot logon task; no prompts.
cd /d "%~dp0.."
npm start >> data\bot.log 2>&1
