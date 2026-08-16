$acl = Get-Acl 'D:\Project\tts_broker_openai_compat\venv'
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.SetAccessRule($rule)
$rule2 = New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\Users','ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
$acl.SetAccessRule($rule2)
Set-Acl 'D:\Project\tts_broker_openai_compat\venv' $acl
Write-Host "Done: venv permissions set (Admins=Full, Users=Read)"
