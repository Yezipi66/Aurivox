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

# backend 是平台自己的端口，不是引擎知识，留在这里。
$Ports = @(
  @{ Name = "backend server.js"; Port = 9886 }
)

# 引擎的端口问名片要 —— 这个文件里不该有任何一台具体引擎的知识。
#
# ⭐⭐ 但停止脚本的可靠性高于一切：它原本一个外部程序都不用，改成问 node
#    就等于给"停不掉服务"新增一个失败原因，而停不掉的进程会锁住文件
#    （见本文件顶部那笔账）。所以问不到时**只警告不退出**，交给下面第二遍
#    （按项目目录扫进程）兜底 —— 那一遍更强，且不依赖任何外部程序。
#
# 要的是名片声明的默认端口：停止脚本不知道上次启动有没有把端口挪走过，
# 挪走过的那台同样由第二遍兜住。
function Get-EnginePorts {
  $root = Get-ProjectRoot
  if (-not $root) { return @() }
  $node = Join-Path $root 'tools\runtime\node\node.exe'
  if (-not (Test-Path -LiteralPath $node)) { $node = 'node' }
  $cli = Join-Path $root 'lib\engines\engine-launch-plan.cjs'
  if (-not (Test-Path -LiteralPath $cli)) { return @() }
  try {
    $txt = (& $node $cli '--all' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { return @() }
    $data = $txt | ConvertFrom-Json
  } catch { return @() }
  $out = @()
  foreach ($e in $data.engines) {
    if ($e.ok -and $e.launchable) {
      $out += @{ Name = ("engine " + $e.id); Port = [int]$e.port }
    }
  }
  return $out
}

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

# ⚠ PS 5.1：函数必须先定义后调用（顺序执行，没有提升）。这段之所以在这里
#    而不是跟着 $Ports 走，就是因为 Get-EnginePorts 要用上面的 Get-ProjectRoot。
$enginePorts = Get-EnginePorts
if ($enginePorts.Count -eq 0) {
  Write-Host "  [WARN] 拿不到引擎端口列表(名片/node)，改由下面第二遍按项目目录清理。" -ForegroundColor Yellow
} else {
  # ⚠ PS 5.1 坑：单元素数组在 += 时会被拆成标量。用 @() 包住再展开。
  foreach ($ep in @($enginePorts)) { $Ports += $ep }
}

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
