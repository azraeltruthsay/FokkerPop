' Launch the FokkerPop server with no visible console window, then open
' the dashboard in the user's default browser.
'
' Invoked by start.bat and by the "FokkerPop" Start Menu shortcut created
' by the NSIS updater. Safe to run multiple times — a WMI query detects an
' already-running FokkerPop.exe and short-circuits the server launch so the
' user just gets a fresh browser tab against the existing instance.
'
' Stops via stop.bat, the "Stop FokkerPop" Start Menu shortcut, the Stop
' FokkerPop button in the dashboard Setup page, or Task Manager.

Option Explicit

Dim fso, shell, scriptDir, nodeExe, entry
Dim wmi, procs, alreadyRunning
Dim dashUrl

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

nodeExe = fso.BuildPath(scriptDir, "node\FokkerPop.exe")
entry   = fso.BuildPath(scriptDir, "server\index.js")
dashUrl = "http://localhost:4747/dashboard/"

If Not fso.FileExists(nodeExe) Then
  MsgBox "FokkerPop: bundled Node runtime is missing. Did the install finish?" _
         & vbCrLf & vbCrLf & "Expected: " & nodeExe, vbCritical, "FokkerPop"
  WScript.Quit 1
End If

If Not fso.FileExists(entry) Then
  MsgBox "FokkerPop: server/index.js is missing. Did the install finish?" _
         & vbCrLf & vbCrLf & "Expected: " & entry, vbCritical, "FokkerPop"
  WScript.Quit 1
End If

' Single-instance guard. Win32_Process name is case-insensitive.
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select ProcessId from Win32_Process Where Name = 'FokkerPop.exe'")
alreadyRunning = (procs.Count > 0)

If Not alreadyRunning Then
  ' Window style 0 = SW_HIDE, third arg False = don't wait.
  shell.Run """" & nodeExe & """ """ & entry & """", 0, False
  ' Give the server a moment to bind port 4747 before the browser asks for it,
  ' otherwise Fokker sees a brief "Can't reach this page" error instead of
  ' the dashboard.
  WScript.Sleep 2000
End If

' Open (or re-focus) the dashboard. Using "cmd /c start" triggers Windows'
' default-browser handling without leaving a cmd window behind.
shell.Run "cmd /c start """" """ & dashUrl & """", 0, False
