@echo off
rem Tail the 9Router dev log (Ctrl+C to stop watching)
powershell -NoProfile -Command "Get-Content 'C:\Users\Admin\Downloads\9router\data\logs\dev.log' -Wait -Tail 50"
