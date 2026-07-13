[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
#  TTS Broker stop script (relocated under tools\scripts)
#  Locate LISTENING processes by port and terminate:
#    - backend server.js : 9886
#    - engine infer      : 9880
#  Only kills LISTENING (server-side) processes.
# ============================================================

$Ports = @(
  @{ Name = "backend server.js"; Port = 9886 },
  @{ Name = "engine infer_server"; Port = 9880 }
)

function Get-ListeningPids($port) {
  $found = @()
  $lines = netstat -ano | Select-String "LISTENING"
  foreach ($ln in $lines) {
    $text = $ln.ToString()
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
    Write-Host ("  :{0,-5} {1,-20} no listening process (not running)" -f $port, $name) -ForegroundColor DarkGray
    continue
  }
  foreach ($procId in $pids) {
    try {
      $proc = Get-Process -Id $procId -ErrorAction Stop
      Stop-Process -Id $procId -Force -ErrorAction Stop
      Write-Host ("  :{0,-5} {1,-20} stopped PID={2} ({3})" -f $port, $name, $procId, $proc.ProcessName) -ForegroundColor Green
      $killedAny = $true
    } catch {
      Write-Host ("  :{0,-5} {1,-20} failed to stop PID={2}: {3}" -f $port, $name, $procId, $_.Exception.Message) -ForegroundColor Red
    }
  }
}

if (-not $killedAny) {
  Write-Host "  (no services were running)" -ForegroundColor Yellow
}
Write-Host "=========================================================" -ForegroundColor Cyan
