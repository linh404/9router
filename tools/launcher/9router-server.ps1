param(
    [Parameter(Mandatory = $true)][string]$RouterDir,
    [Parameter(Mandatory = $true)][int]$ShellPid
)

# Hidden watchdog: runs the dev server, tees output to a log file, and kills
# the whole server tree when the launching terminal dies.

$logDir = Join-Path $RouterDir 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'dev.log'
$errLog = Join-Path $logDir 'dev.err.log'

"=== 9router-server started $(Get-Date -Format o) (watching terminal PID $ShellPid) ===" |
    Out-File -FilePath $log -Append -Encoding utf8

$npm = Join-Path $env:ProgramFiles 'nodejs\npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm' }

$proc = Start-Process -FilePath $npm `
    -ArgumentList 'run', 'dev' `
    -WorkingDirectory $RouterDir `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $log `
    -RedirectStandardError $errLog

# Watchdog: exit as soon as the launching terminal dies (or server self-exits)
while ($true) {
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Id $ShellPid -ErrorAction SilentlyContinue)) {
        "Terminal $ShellPid closed - stopping 9Router..." | Out-File -FilePath $log -Append -Encoding utf8
        break
    }
    if ($proc.HasExited) {
        "Server exited on its own (code $($proc.ExitCode))." | Out-File -FilePath $log -Append -Encoding utf8
        break
    }
}

# Kill the whole npm/next/node process tree
try { & taskkill /PID $proc.Id /T /F 2>$null | Out-Null } catch { }
"=== 9router-server stopped $(Get-Date -Format o) ===" | Out-File -FilePath $log -Append -Encoding utf8
exit 0
