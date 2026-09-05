# Prints the PID of the interactive terminal that launched 9router.cmd.
# Call chain: user's shell -> cmd (batch) -> powershell (this script).
# This script's parent = the batch cmd; grandparent = the user's terminal shell.
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" | Select-Object -ExpandProperty ParentProcessId
$grandparent = Get-CimInstance Win32_Process -Filter "ProcessId = $parent" | Select-Object -ExpandProperty ParentProcessId
Write-Output $grandparent
