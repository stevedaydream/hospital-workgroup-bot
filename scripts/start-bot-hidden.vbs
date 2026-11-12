' Starts run-bot-forever.bat without a console window, so it cannot be closed by accident.
Set shell = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & dir & "\run-bot-forever.bat""", 0, False
