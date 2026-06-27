$acl = Get-Acl 'D:\Project\tts_broker_openai_compat\venv'
# 添加当前用户的"拒绝写入"规则，不影响其他继承权限
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$denyWrite = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $me, 'Write,Delete,CreateFiles,AppendData,DeleteSubdirectoriesAndFiles',
    'ContainerInherit,ObjectInherit','None','Deny')
$acl.AddAccessRule($denyWrite)
Set-Acl 'D:\Project\tts_broker_openai_compat\venv' $acl
Write-Host "Done: user '$me' denied write access to venv (inheritance preserved)"
