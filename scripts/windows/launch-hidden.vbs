If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

Dim shell, scriptPath, command
Set shell = CreateObject("WScript.Shell")
scriptPath = WScript.Arguments(0)
command = "cmd.exe /c """ & scriptPath & """"
shell.Run command, 0, False
