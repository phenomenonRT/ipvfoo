Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' Path to this script's directory
scriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' Path to server.py
serverPy = scriptDir & "\server.py"

' Run python invisibly (0 = hidden window, False = don't wait)
objShell.Run "pythonw.exe """ & serverPy & """", 0, False

WScript.Quit
