' TTS Broker 静默启动入口 (双击运行, 零黑窗)
Option Explicit
Dim fso, sh, baseDir, psFile, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
psFile  = baseDir & "\start.ps1"

If Not fso.FileExists(psFile) Then
  MsgBox "找不到 start.ps1:" & vbCrLf & psFile, vbCritical, "TTS Broker"
  WScript.Quit 1
End If

cmd = "powershell -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File """ & psFile & """"
sh.Run cmd, 0, False
