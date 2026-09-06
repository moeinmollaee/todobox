Option Explicit

Dim fso, shell, scriptDir, ps1, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = scriptDir & "\TodoBox-tray.ps1"

cmd = "powershell.exe -NoProfile -WindowStyle Hidden -Sta -ExecutionPolicy Bypass -File """ & ps1 & """"
shell.Run cmd, 0, False
