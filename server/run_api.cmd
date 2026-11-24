@echo off
REM Detached API launcher - survives this terminal closing, does not hold its stdout.
cd /d "%~dp0"
start "" /min cmd /c "node --env-file=.env src/server.js >> api.log 2>&1"
