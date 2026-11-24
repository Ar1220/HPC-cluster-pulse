@echo off
REM =============================================================
REM  CLUSTER PULSE - laptop control
REM
REM  Double-click this file  -> interactive menu
REM  Or from a terminal:
REM      pulse status | start | stop | restart | logs | open
REM =============================================================
setlocal
cd /d "%~dp0"

if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pulse.ps1"
    echo.
    echo   (window stays open so you can read the result)
    pause
    goto :eof
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pulse.ps1" %*
