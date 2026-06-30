[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
#  TTS Broker 停止脚本
#  按端口定位 LISTENING 进程的 PID 并结束:
#    - 后端 server.js : 9886
#    - 推理 infer     : 9880
#  仅杀 LISTENING(服务端)进程, 不误伤普通连接。
# ============================================================

$Ports = @(
  @{ Name = "后端 server.js"; Port = 9886 },
  @{ Name = "推理 infer_server"; Port = 9880 }
)

function Get-ListeningPids($port) {
  $found = @()
  $lines = netstat -ano | Select-String "LISTENING"
  foreach ($ln in $lines) {
    $text = $ln.ToString()
    # 只匹配本地地址以 :port 结尾的行(避免远端端口巧合)
    if ($text -match "[:\.]$port\s") {
      $parts = ($text -split "\s+") | Where-Object { $_ -ne "" }
      $procId = $parts[$parts.Count - 1]
      if ($procId -match "^\d+$") { $found += [int]$procId }
    }
  }
  return ($found | Sort-Object -Unique)
}

Write-Host "==================== TTS Broker Stop ====================" -ForegroundColor Cyan
$killedAny = $false

foreach ($item in $Ports) {
  $port = $item.Port
  $name = $item.Name
  $pids = Get-ListeningPids $port
  if (-not $pids -or $pids.Count -eq 0) {
    Write-Host ("  :{0,-5} {1,-20} 无监听进程(未运行)" -f $port, $name) -ForegroundColor DarkGray
    continue
  }
  foreach ($procId in $pids) {
    try {
      $proc = Get-Process -Id $procId -ErrorAction Stop
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Host ("  :{0,-5} {1,-20} 已停止 PID={2} ({3})" -f $port, $name, $procId, $proc.ProcessName) -ForegroundColor Green
      $killedAny = $true
    } catch {
      Write-Host ("  :{0,-5} {1,-20} 停止 PID={2} 失败: {3}" -f $port, $name, $procId, $_.Exception.Message) -ForegroundColor Red
    }
  }
}

if (-not $killedAny) {
  Write-Host "  (没有正在运行的服务)" -ForegroundColor Yellow
}
Write-Host "========================================================" -ForegroundColor Cyan
