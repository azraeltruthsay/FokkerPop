' Launch the FokkerPop server with no visible console window.
'
' Invoked by start.bat after all diagnostic checks pass, so the CMD that
' kicked off the launch can close cleanly and Fokker sees only the browser
' tab. Stops via stop.bat, the Stop FokkerPop button in the dashboard Setup
' page, or Task Manager -> FokkerPop.exe.
'
' WScript.Shell.Run second arg = 0 (SW_HIDE) so no window flashes at all.
' Third arg = False: fire-and-forget; the VBS exits immediately.

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

nodeExe = fso.BuildPath(scriptDir, "node\FokkerPop.exe")
entry   = fso.BuildPath(scriptDir, "server\index.js")

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

shell.Run """" & nodeExe & """ """ & entry & """", 0, False
