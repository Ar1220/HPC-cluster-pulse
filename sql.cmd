@echo off
REM ---------------------------------------------------------------
REM  Cluster Pulse - MySQL console
REM
REM   sql                       open an interactive MySQL prompt
REM   sql "SELECT 1;"           run one statement and exit
REM   sql -f queries.sql        run a whole .sql file
REM
REM  The root password is read from server\.env, so it is never
REM  typed on the command line or stored in this file.
REM ---------------------------------------------------------------
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PW="
for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "MYSQL_PASSWORD=" "server\.env"`) do set "PW=%%B"
set "DB=cluster_pulse"

if not defined PW (
  echo Could not read MYSQL_PASSWORD from server\.env
  exit /b 1
)

docker inspect cluster-pulse-mysql >nul 2>&1
if errorlevel 1 (
  echo MySQL container "cluster-pulse-mysql" does not exist.
  echo Start it with:  docker run -d --name cluster-pulse-mysql -p 3306:3306 -e MYSQL_ROOT_PASSWORD=... mysql:8.4
  exit /b 1
)

if "%~1"=="" (
  echo Connected to %DB%. Type SQL, end statements with ;  ^|  exit to leave.
  docker exec -it cluster-pulse-mysql mysql -uroot -p!PW! %DB%
  goto :eof
)

if /i "%~1"=="-f" (
  if not exist "%~2" (
    echo File not found: %~2
    exit /b 1
  )
  REM pipe the local .sql file into the container's client
  docker exec -i cluster-pulse-mysql mysql -uroot -p!PW! %DB% < "%~2"
  goto :eof
)

REM batch mode: no -i/-t, otherwise docker refuses when stdin is not a terminal
docker exec cluster-pulse-mysql mysql -uroot -p!PW! %DB% %*
