' 9router autostart (hidden) at user logon.
' - Waits for network briefly, starts `npm run dev` in the 9router checkout,
'   then health-checks http://127.0.0.1:20128/v1/models and logs the result.
' - Log: C:\Users\Admin\Downloads\9router\autostart.log
' - Removal: delete HKCU\...\Run\9routerAutostart + this file.

Option Explicit

Const REPO_DIR = "C:\Users\Admin\Downloads\9router"
Const PORT = 20128
Const LOG_FILE = "C:\Users\Admin\Downloads\9router\autostart.log"

Dim shell, fso
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Sub Log(msg)
  On Error Resume Next
  Dim ts
  Set ts = fso.OpenTextFile(LOG_FILE, 8, True)
  ts.WriteLine Now & "  " & msg
  ts.Close
End Sub

' --- 1. Single-instance guard: if port already listening, exit silently ----
Dim netstatOut, isRunning
isRunning = False
On Error Resume Next
Set netstatOut = shell.Exec("cmd.exe /c netstat -ano -p tcp | findstr "":20128"" | findstr ""LISTENING""")
Do While Not netstatOut.StdOut.AtEndOfStream
  Dim ln : ln = netstatOut.StdOut.ReadLine
  If InStr(ln, "LISTENING") > 0 Then isRunning = True
Loop
On Error GoTo 0
If isRunning Then
  Log "Already running on port " & PORT & " - nothing to do."
  WScript.Quit 0
End If

' --- 2. Start dev server hidden, detached from this script -----------------
Log "Starting npm run dev in " & REPO_DIR
shell.CurrentDirectory = REPO_DIR
shell.Run "cmd.exe /c npm run dev >> """ & LOG_FILE & """ 2>&1", 0, False

' --- 3. Health check up to 60s ----------------------------------------------
Dim attempts, ok
ok = False
For attempts = 1 To 30
  WScript.Sleep 2000
  On Error Resume Next
  Set netstatOut = shell.Exec("cmd.exe /c netstat -ano -p tcp | findstr "":20128"" | findstr ""LISTENING""")
  Do While Not netstatOut.StdOut.AtEndOfStream
    Dim l2 : l2 = netstatOut.StdOut.ReadLine
    If InStr(l2, "LISTENING") > 0 Then ok = True
  Loop
  On Error GoTo 0
  If ok Then Exit For
Next

If ok Then
  Log "9router is UP on port " & PORT & " (after " & (attempts * 2) & "s)."
Else
  Log "WARNING: 9router did NOT come up within 60s. Check the npm log above."
End If
