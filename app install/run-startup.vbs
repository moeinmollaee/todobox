Option Explicit

Dim fso, shell, scriptDir, rootDir, port, cmd, openApp, i, tmp

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
port = "8080"
openApp = False
tmp = shell.ExpandEnvironmentStrings("%TEMP%") & "\todobox-port.chk"

If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "open" Then openApp = True
End If

shell.CurrentDirectory = rootDir

Function PortListening()
  Dim f, content
  On Error Resume Next
  If fso.FileExists(tmp) Then fso.DeleteFile tmp, True
  On Error GoTo 0
  shell.Run "cmd /c netstat -ano | findstr :" & port & " | findstr LISTENING > """ & tmp & """", 0, True
  If Not fso.FileExists(tmp) Then
    PortListening = False
    Exit Function
  End If
  Set f = fso.OpenTextFile(tmp, 1)
  content = Trim(f.ReadAll)
  f.Close
  fso.DeleteFile tmp, True
  PortListening = (Len(content) > 0)
End Function

If PortListening() Then
  If openApp Then shell.Run "http://localhost:" & port & "/app.html", 1, False
  WScript.Quit 0
End If

If Not fso.FileExists(rootDir & "\vendor\sql-wasm.js") Then
  shell.Run "cmd /c """ & scriptDir & "\install.bat""", 0, True
End If

cmd = "cmd /c npx --yes serve -l " & port & " ."
shell.Run cmd, 0, False

If openApp Then
  For i = 1 To 24
    WScript.Sleep 500
    If PortListening() Then Exit For
  Next
  shell.Run "http://localhost:" & port & "/app.html", 1, False
End If
