[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
#  TTS Broker stop script (relocated under tools\scripts)
#  Terminate the backend (:9886) and the inference engine (:9880).
#
#  Two passes, because listening on a port and running are not the same thing:
#    1. by port  -- the normal case;
#    2. by executable location -- a process that has stopped listening but is
#       still alive still holds file locks, so "no listening process" is not
#       the same as "nothing is running". A backend that had dropped its
#       listener was reported as not running by this script and then blocked a
#       file migration for as long as it took to find it by hand.
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

# Project root = the directory holding package.json, found by walking up.
# Never by counting directory levels: this file has been moved before, and a
# level count keeps "working" while pointing somewhere wrong.
function Get-ProjectRoot {
  $d = Split-Path -Parent $PSCommandPath
  while ($d) {
    if (Test-Path -LiteralPath (Join-Path $d 'package.json')) { return $d }
    $parent = Split-Path -Parent $d
    if ($parent -eq $d) { return $null }
    $d = $parent
  }
  return $null
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

# Pass 2: anything still running from inside the project directory.
$root = Get-ProjectRoot
if ($root) {
  $leftovers = @()
  foreach ($p in Get-Process) {
    if ($p.Id -eq $PID) { continue }
    $exe = $null
    try { $exe = $p.Path } catch { }
    if (-not $exe) { continue }
    if ($exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $leftovers += $p
    }
  }
  foreach ($p in $leftovers) {
    try {
      Stop-Process -Id $p.Id -Force -ErrorAction Stop
      Write-Host ("  {0,-27} stopped PID={1} ({2})" -f 'still-running (no listener)', $p.Id, $p.Path) -ForegroundColor Green
      $killedAny = $true
    } catch {
      Write-Host ("  {0,-27} failed to stop PID={1}: {2}" -f 'still-running (no listener)', $p.Id, $_.Exception.Message) -ForegroundColor Red
    }
  }
}

if (-not $killedAny) {
  Write-Host "  (no services were running)" -ForegroundColor Yellow
}
Write-Host "=========================================================" -ForegroundColor Cyan
