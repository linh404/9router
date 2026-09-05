@echo off
rem Stop the 9Router dev server + its hidden watchdog (use when started detached)
powershell -NoProfile -Command ^
 "$k=Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match '9router-server\.ps1' };" +
 "foreach($x in $k){ & taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null };" +
 "$pids=(Get-NetTCPConnection -LocalPort 20127 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique;" +
 "foreach($p in $pids){ if($p){ & taskkill /PID $p /T /F 2>$null | Out-Null } };" +
 "if($k -or $pids){ Write-Host '9Router stopped.' } else { Write-Host '9Router was not running.' }"
