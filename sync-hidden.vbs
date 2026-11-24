' Runs pulse.ps1 sync with no console window at all.
' A scheduled task pointing straight at powershell.exe opens a console every
' time it fires; wscript with window style 0 does not.
Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\hermes\workspace\test1\project\pulse.ps1"" sync"
shell.Run cmd, 0, False
