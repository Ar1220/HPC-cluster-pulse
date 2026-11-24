@echo off
REM Detached Angular dev-server launcher.
cd /d "%~dp0"
start "" /min cmd /c "node node_modules\@angular\cli\bin\ng.js serve --port 4200 >> ngserve.log 2>&1"
