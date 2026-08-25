[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
#  TTS Broker startup orchestrator (relocated under tools\scripts)
#  - Project root is two levels up from this script.
#  - Uses the BUNDLED portable Node (tools\runtime\node\node.exe)
#    and the deployed venv Python (venv\Scripts\python.exe).
#  - Frontend is shipped pre-built (web\dist); build only runs as
#    a fallback when dist is missing.
# ============================================================

$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
# tools\scripts -> tools -> <root>
$BASE_DIR = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent

# --- CHECK: warn (do NOT refuse) on a non-ASCII (e.g. Chinese) install path -
# A non-English path CAN mangle to D:\??\ when child processes (python/ffmpeg)
# are launched via a legacy GBK console, which may break the engine/backend.
# We force PYTHONUTF8/UTF-8 for children below, and modern Windows generally
# handles Unicode paths, so this is now a non-fatal warning instead of a hard
# refusal: startup continues and the user decides. Validate $BASE_DIR (real
# Unicode from $PSScriptRoot) which is not '?'-mangled like a console readback.
$__badChars = @()
foreach ($c in $BASE_DIR.ToCharArray()) { if ([int][char]$c -gt 127) { $__badChars += $c } }
if ($__badChars.Count -gt 0) {
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Yellow
  Write-Host '[start][WARN] Install path contains non-ASCII characters.' -ForegroundColor Yellow
  Write-Host ('  path : {0}' -f $BASE_DIR) -ForegroundColor Yellow
  Write-Host ('  bad  : {0}' -f ($__badChars -join ' ')) -ForegroundColor Yellow
  Write-Host '  A non-English path (Chinese etc.) MAY break Python/ffmpeg' -ForegroundColor Yellow
  Write-Host '  process launching on some Windows setups. If the backend or' -ForegroundColor Yellow
  Write-Host '  inference engine fails to start, move the WHOLE folder to a' -ForegroundColor Yellow
  Write-Host '  pure-English path such as  D:\TTS-Broker  and re-run.' -ForegroundColor Yellow
  Write-Host '  Continuing startup ...' -ForegroundColor Yellow
  Write-Host '============================================================' -ForegroundColor Yellow
}

# Force UTF-8 for every child process (backend server.js, the Python inference
# engine, and anything they spawn). Prevents the Chinese-Windows GBK console
# from throwing UnicodeEncodeError when the engine logs non-GBK characters
# (e.g. U+FFFD), which otherwise crashes /v1/audio/speech with a 502.
$env:PYTHONUTF8        = '1'
$env:PYTHONIOENCODING  = 'utf-8'
$env:PYTHONUNBUFFERED  = '1'

# ── 起哪台引擎、拿什么起：问名片，不写在这里 ───────────────────────────
# 搬家前这里躺着五个 $ENGINE_* 变量，全是 GPT-SoVITS 专有的（解释器、
# 入口、配置文件、监听地址）。它们合起来是一张没写在名片上的名片：
# 第三台引擎的作者会发现名片写完了引擎还是起不来，因为得改这个文件 ——
# 而那正是「加一台引擎不碰 lib/」这条标准要挡住的事。
#
# ⭐ 只搬「起什么」，不搬「怎么起」：下面那 90 行端口逻辑（Test-Port /
#   Get-ListenerPid / Resolve-Port / Test-IsOwnProcess）一行没动。它们是
#   被真机 bug 打磨出来的 Windows 专有知识，重写它们没法保证行为不变。
$ENGINE_ID = $env:ENGINE_ID
if (-not $ENGINE_ID) { $ENGINE_ID = 'gpt-sovits' }

# 问一次名片。$Port 给了就按它算命令行，不给就用名片声明的默认端口。
# ⚠ 纯函数，无副作用，可以放心问两次 —— 第一次拿期望端口去解冲突，
#   解完带着定下来的端口再问一次要最终命令行。
function Get-EnginePlan {
  param([int]$Port = 0)
  $cli  = Join-Path $BASE_DIR 'lib\engines\engine-launch-plan.cjs'
  $args = @($cli, '--engine', $ENGINE_ID)
  if ($Port -gt 0) { $args += @('--port', "$Port") }
  $raw = & $NODE $args 2>&1
  $txt = ($raw | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    Log ('[engine][ERROR] 算不出 {0} 的启动计划: {1}' -f $ENGINE_ID, $txt) 'Red'
    return $null
  }
  try { return $txt | ConvertFrom-Json } catch {
    Log ('[engine][ERROR] 启动计划不是合法 JSON: {0}' -f $txt) 'Red'
    return $null
  }
}
$BACKEND_PORT  = 9886
$BACKEND_WAIT  = 30

# --- Resolve Node: prefer bundled portable node, fall back to PATH ---
$BUNDLED_NODE = Join-Path $BASE_DIR 'tools\runtime\node\node.exe'
$BUNDLED_NPM  = Join-Path $BASE_DIR 'tools\runtime\node\npm.cmd'
if (Test-Path $BUNDLED_NODE) {
  $NODE = $BUNDLED_NODE
  $NPM  = $BUNDLED_NPM
  # ensure bundled node dir is first on PATH so npm/node child procs resolve
  $env:PATH = (Split-Path $BUNDLED_NODE -Parent) + ';' + $env:PATH
} else {
  $NODE = 'node'
  $NPM  = 'npm'
}

$LogDir = Join-Path $BASE_DIR 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$StartupLog = Join-Path $LogDir 'startup.log'

function Log {
  param([string]$msg, [string]$color = 'Gray')
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $StartupLog -Value $line -Encoding UTF8
}

function Test-Port {
  param([int]$port)
  # Only treat a port as "in use" when a process is actually LISTENING on it.
  # netstat rows in TIME_WAIT/CLOSE_WAIT/ESTABLISHED linger for tens of seconds
  # after Stop kills the listener; matching them would make start falsely skip
  # relaunch (the "click Stop, then Start twice" bug). Match stop.ps1's rule.
  $result = netstat -ano | Select-String 'LISTENING' | Select-String ('[:\.]{0}\s' -f $port)
  return ($null -ne $result)
}

function Test-HttpReady {
  param([string]$url)
  try {
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -gt 0) { return $true }
    return $false
  }
}

# ============================================================
#  PORT OCCUPANCY PROTECTION
#  Distinguish OUR leftover (reuse the port, skip relaunch) from a STRANGER
#  program (shift to the next free port). See Resolve-Port for the wiring.
# ============================================================

# PID of the process LISTENING on $port (or $null). Prefer Get-NetTCPConnection;
# fall back to parsing netstat when the cmdlet is unavailable (older hosts).
function Get-ListenerPid {
  param([int]$port)
  try {
    $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    if ($conns) { return [int]($conns | Select-Object -First 1 -ExpandProperty OwningProcess) }
  } catch {
    $line = netstat -ano | Select-String 'LISTENING' | Select-String ('[:\.]{0}\s' -f $port) | Select-Object -First 1
    if ($line) {
      $cols = ($line.ToString().Trim() -split '\s+') | Where-Object { $_ -ne '' }
      if ($cols.Count -ge 1) { $last = $cols[$cols.Count - 1]; if ($last -match '^\d+$') { return [int]$last } }
    }
  }
  return $null
}

# ExecutablePath + full CommandLine for a PID (best-effort; either may be blank).
function Get-ProcInfoById {
  param([int]$procId)
  $info = @{ Path = ''; CommandLine = '' }
  try {
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f $procId) -ErrorAction Stop
    if ($p) { $info.Path = [string]$p.ExecutablePath; $info.CommandLine = [string]$p.CommandLine }
  } catch {
    try { $pp = Get-Process -Id $procId -ErrorAction Stop; $info.Path = [string]$pp.Path } catch { }
  }
  return $info
}

# Is the PID one of OUR two services (node server.js / python infer_server.py)
# launched from THIS install root? The base-dir guard prevents mistaking an
# unrelated program that merely happens to have a "server.js" arg for ours.
function Test-IsOwnProcess {
  param([int]$procId, [string]$baseDir)
  if (-not $procId) { return $false }
  $pi  = Get-ProcInfoById -procId $procId
  $hay = (($pi.Path + ' ' + $pi.CommandLine)).ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($hay)) { return $false }
  $baseLc    = $baseDir.ToLowerInvariant()
  $underBase = $hay.Contains($baseLc)
  $isBackend = $hay.Contains('server.js')
  # 引擎的记号来自名片（见 $ENGINE_PROC_MARK 的赋值处）。拿不到就只认
  # backend —— 宁可漏认自家引擎（后果是端口往上挪一个，还能起来），
  # 也不要瞎猜一个名字去误伤别人的进程。
  $isEngine  = ($ENGINE_PROC_MARK -and $hay.Contains($ENGINE_PROC_MARK))
  return ($underBase -and ($isBackend -or $isEngine))
}

# First port >= $startPort with no LISTENER (probe the next free port).
function Get-FreePort {
  param([int]$startPort, [int]$maxTries = 50)
  for ($p = $startPort; $p -lt ($startPort + $maxTries); $p++) {
    if ($p -gt 65535) { break }
    if (-not (Test-Port $p)) { return $p }
  }
  return $null
}

# Resolve a desired port into an action:
#   free      -> nobody listening; use $desired, launch normally.
#   own       -> OUR leftover holds it; reuse $desired, skip relaunch.
#   shifted   -> a STRANGER holds it; use the next free port, launch there.
#   exhausted -> no free port found near $desired (fatal).
function Resolve-Port {
  param([string]$name, [int]$desired, [string]$baseDir)
  $res = @{ Name = $name; Port = $desired; Action = 'free'; OwnerPid = $null }
  if (-not (Test-Port $desired)) { return $res }
  $ownerPid    = Get-ListenerPid -port $desired
  $res.OwnerPid = $ownerPid
  if (Test-IsOwnProcess -procId $ownerPid -baseDir $baseDir) { $res.Action = 'own'; return $res }
  $free = Get-FreePort -startPort ($desired + 1)
  if ($null -eq $free) { $res.Action = 'exhausted'; return $res }
  $res.Port   = $free
  $res.Action = 'shifted'
  return $res
}

'==== TTS Broker startup @ {0} ====' -f (Get-Date) | Out-File -FilePath $StartupLog -Encoding UTF8
Log '==================== TTS Broker Startup ====================' 'Cyan'
Log ('root : {0}' -f $BASE_DIR) 'DarkGray'
Log ('node : {0}' -f $NODE) 'DarkGray'

# --- Guard: 这台引擎装没装 ---
# 搬家前这里查的是写死的 venv\Scripts\python.exe。第三台引擎完全可能用别的
# 解释器（自己的 venv、conda、系统 python），查死一个路径等于规定所有引擎
# 必须共用一个 venv —— 那条规定从来没人同意过，只是写在了这一行里。
$plan0 = Get-EnginePlan
if ($null -eq $plan0) { Log '[engine][ERROR] 拿不到启动计划，无法继续。' 'Red'; exit 1 }
if ($plan0.launchable) {
  if (-not (Test-Path $plan0.python)) {
    Log ('[ERROR] 引擎 {0} 的解释器不存在: {1}' -f $ENGINE_ID, $plan0.python) 'Red'
    Log '        Run 首次部署.bat first.' 'Red'
    exit 1
  }
} else {
  # 名片没写 runtime = 这台引擎由作者自己起。不是错误，但要说出来，
  # 否则后面"引擎没上线"会看着像 bug。
  Log ('[engine] {0} 不由平台启动（名片没有 runtime 段）。' -f $ENGINE_ID) 'Yellow'
}

# 0. Frontend: shipped pre-built. Build only as fallback when dist missing.
$webDir     = Join-Path $BASE_DIR 'web'
$distIdx    = Join-Path $webDir 'dist\index.html'
$distAssets = Join-Path $webDir 'dist\assets'

if ((-not (Test-Path $distIdx)) -or (-not (Test-Path $distAssets))) {
  Log '[build] web\dist missing -> attempting fallback build (needs bundled node).' 'Yellow'
  $hasNodeModules = Test-Path (Join-Path $webDir 'node_modules')
  if ($hasNodeModules) {
    $buildCmd = ('"{0}" run build' -f $NPM)
  } else {
    $buildCmd = ('"{0}" install && "{0}" run build' -f $NPM)
  }
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',$buildCmd) -WorkingDirectory $webDir -WindowStyle Normal -Wait
  if (Test-Path $distAssets) { Log '[build] fallback build finished [OK]' 'Green' }
  else { Log '[build][WARN] fallback build may have failed. Check the build window.' 'Red' }
} else {
  Log '[build] web\dist present (shipped pre-built). Skip build.' 'Green'
}

# ── Resolve engine + backend ports BEFORE launching anything ───────────────
# Must run first so the backend inherits the resolved GPT_SOVITS_BASE_URL /
# BROKER_PORT env at spawn time. After a shift the whole chain agrees on the
# new numbers:
#   * engine  : told -p <port>, and reached via $env:GPT_SOVITS_BASE_URL
#               (backend synthesis client + /api/health both read this).
#   * backend : reads $env:BROKER_PORT; browser opens the resolved port.
#   * frontend: served SAME-ORIGIN by the backend (web\dist, relative fetch in
#               web/src/lib/api.js -> API_BASE=''), so a shifted backend port
#               needs NO port injection — opening the resolved URL is enough.
# ── 这台引擎想听哪儿、怎么认出它自己的进程（$plan0 在上面的守卫处已算好）──
# ⭐ 端口保护对**不可启动**的引擎同样生效：作者自己起的引擎照样占着 9880，
#   别的程序就不该占它。所以 host/port 这几样，计划在不可启动时也会给。
$ENGINE_HOST      = $plan0.host
$ENGINE_PORT      = [int]$plan0.desired_port
$ENGINE_PROC_MARK = $plan0.own_process_mark
Log ('[engine] {0} ({1}) 期望监听 {2}:{3}' -f $ENGINE_ID, $plan0.label, $ENGINE_HOST, $ENGINE_PORT) 'DarkGray'

$engineRes  = Resolve-Port -name 'engine'  -desired $ENGINE_PORT  -baseDir $BASE_DIR
$backendRes = Resolve-Port -name 'backend' -desired $BACKEND_PORT -baseDir $BASE_DIR
foreach ($r in @($engineRes, $backendRes)) {
  switch ($r.Action) {
    'free'      { Log ('[port] {0}: {1} is free.' -f $r.Name, $r.Port) 'DarkGray' }
    'own'       { Log ('[port] {0}: {1} already held by OUR process (pid {2}) - reuse, skip relaunch.' -f $r.Name, $r.Port, $r.OwnerPid) 'Yellow' }
    'shifted'   { Log ('[port] {0}: desired port busy (foreign pid {1}); shifted -> {2}.' -f $r.Name, $r.OwnerPid, $r.Port) 'Yellow' }
    'exhausted' { Log ('[port][ERROR] {0}: no free port found near desired. Aborting.' -f $r.Name) 'Red' }
  }
}
if (($engineRes.Action -eq 'exhausted') -or ($backendRes.Action -eq 'exhausted')) { exit 1 }
$ENGINE_PORT  = [int]$engineRes.Port
$BACKEND_PORT = [int]$backendRes.Port
# Wire the resolved ports through the whole chain via inherited environment.
$env:GPT_SOVITS_BASE_URL = 'http://{0}:{1}' -f $ENGINE_HOST, $ENGINE_PORT
$env:BROKER_PORT         = "$BACKEND_PORT"
Log ('[port] engine  -> {0}  (GPT_SOVITS_BASE_URL={1})' -f $ENGINE_PORT, $env:GPT_SOVITS_BASE_URL) 'DarkGray'
Log ('[port] backend -> {0}  (BROKER_PORT={1})' -f $BACKEND_PORT, $env:BROKER_PORT) 'DarkGray'

# 1. Backend
Log ('[1/2] Backend server.js on port {0} ...' -f $BACKEND_PORT) 'Green'
if ($backendRes.Action -eq 'own') {
  Log ('      Port {0} already held by OUR backend. Treat backend as running.' -f $BACKEND_PORT) 'Yellow'
} else {
  $beLog = Join-Path $LogDir 'backend.log'
  $beErr = Join-Path $LogDir 'backend.err.log'
  Start-Process -FilePath $NODE -ArgumentList @('server.js') -WorkingDirectory $BASE_DIR -WindowStyle Hidden -RedirectStandardOutput $beLog -RedirectStandardError $beErr | Out-Null
  Log ('      Backend started in background. Waiting up to {0}s ...' -f $BACKEND_WAIT) 'Gray'
}

$backendUrl = 'http://127.0.0.1:{0}/' -f $BACKEND_PORT
$ready = $false
for ($i = 0; $i -lt $BACKEND_WAIT; $i++) {
  Start-Sleep -Seconds 1
  if (Test-HttpReady $backendUrl) { $ready = $true; break }
}
if ($ready) { Log '      Backend ready [OK]. Opening browser.' 'Green' }
else { Log ('      [WARN] Backend not ready in {0}s. Opening browser anyway. See logs\backend*.log.' -f $BACKEND_WAIT) 'Yellow' }
Start-Process $backendUrl | Out-Null

# 1.5 引擎自己的活动配置 (tts_infer.yaml) 由引擎自己自检自修。
# 这里原先有一个 76 行的 Repair-EngineConfig: 逐行读 yaml、挑出路径值、
# 发现被 GBK 控制台写坏的问号或指向已不存在位置的旧路径就备份重建。
# 它是 GPT-SoVITS 独有的收拾工作, 已搬进 lib/inference/config_repair.py,
# 由 lib/inference/infer_server.py 启动时调用 —— 谁起这个进程都一样修。
# ⛔ 别把它搬回来: 平台正在改成按名片起引擎, 启动脚本里不该再有引擎特例。

# 2. Inference engine
Log ('[2/2] Inference service on port {0} ...' -f $ENGINE_PORT) 'Green'
if ($engineRes.Action -eq 'own') {
  Log ('      Port {0} already held by OUR engine. Treat engine as running.' -f $ENGINE_PORT) 'Yellow'
} else {
  # 端口可能被挪过，所以带着定下来的那个再问一次完整计划 ——
  # ⛔ 别用上面 $plan0 的 args：那里面的 -p 还是名片上的旧端口，
  #   引擎会听在没人连的地方，表现成「引擎永远不上线」。
  $plan = Get-EnginePlan -Port $ENGINE_PORT
  $ok = ($null -ne $plan) -and $plan.launchable
  if ($ok -and -not (Test-Path $plan.python)) {
    Log ('      [ERROR] 引擎解释器不存在: {0}' -f $plan.python) 'Red'; $ok = $false
  }
  if ($ok -and -not (Test-Path $plan.entry)) {
    Log ('      [ERROR] 引擎入口不存在: {0}' -f $plan.entry) 'Red'; $ok = $false
  }
  if ($ok) {
    $infLog = Join-Path $LogDir 'inference.log'
    $infErr = Join-Path $LogDir 'inference.err.log'
    # 入口在最前，其余参数由名片给出（$plan.args 里的 {host}/{port} 已展开）。
    $engineArgs = @($plan.entry) + $plan.args
    Log ('      cmd : {0} {1}' -f $plan.python, ($engineArgs -join ' ')) 'DarkGray'
    Log ('      cwd : {0}' -f $plan.cwd) 'DarkGray'
    Start-Process -FilePath $plan.python -ArgumentList $engineArgs -WorkingDirectory $plan.cwd -WindowStyle Hidden -RedirectStandardOutput $infLog -RedirectStandardError $infErr | Out-Null
    Log '      Inference service started in background.' 'Gray'
    Log ('      探活 {0}，预算 {1} 秒。' -f $plan.ready_url, [int]($plan.ready_timeout_ms / 1000)) 'DarkGray'
    Log '      See logs\inference.log / logs\inference.err.log for loading progress.' 'DarkGray'
  }
}

Log '========================================' 'Cyan'
Log ('  UI      : http://127.0.0.1:{0}  opened in browser' -f $BACKEND_PORT) 'Yellow'
Log ('  Backend : http://127.0.0.1:{0}  logs\backend.log' -f $BACKEND_PORT)
Log ('  Engine  : http://127.0.0.1:{0}  logs\inference.log' -f $ENGINE_PORT)
Log '  Launcher will exit. Backend and inference stay running in background.' 'Cyan'
Log '========================================' 'Cyan'
