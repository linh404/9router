@echo off
setlocal
set "ROUTER_DIR=C:\Users\Admin\Downloads\9router"
if not exist "%ROUTER_DIR%\package.json" (
  echo 9Router fork not found at %ROUTER_DIR%
  exit /b 1
)

rem Resolve the PID of the interactive terminal running this script
rem (see 9router-shellpid.ps1: batch cmd's parent is the user's shell)
set "SHELL_PID="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp09router-shellpid.ps1"`) do set "SHELL_PID=%%p"
if not defined SHELL_PID (
  echo Could not resolve terminal PID - refusing to start detached server.
  exit /b 1
)

rem Option B: server runs in a HIDDEN watchdog window (no second terminal).
rem Live log: %ROUTER_DIR%\data\logs\dev.log  (tail it with: 9router-log)
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp09router-server.ps1" "%ROUTER_DIR%" %SHELL_PID%
echo 9Router ^(fork^) starting at http://localhost:20127
echo Dashboard: http://localhost:20127/dashboard
echo Log:       %ROUTER_DIR%\data\logs\dev.log   ^(tail: 9router-log, stop: 9router-stop^)
echo Server stops automatically when this terminal is closed.
