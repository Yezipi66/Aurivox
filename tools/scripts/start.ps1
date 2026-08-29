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

# ── 起哪台引擎、拿什么起：问 manifest.json，不写在这里 ─────────────────
# 搬家前这里躺着五个 $ENGINE_* 变量，全是 GPT-SoVITS 专有的（解释器、
# 入口、配置文件、监听地址）—— 等于一份写在启动脚本里的、谁也改不了的
# manifest.json。第三台引擎的作者会发现 manifest.json 写完了引擎还是起不
# 来，因为得改这个文件 —— 而那正是「加一台引擎不碰 lib/」这条标准要挡住的事。
#
# ⭐ 只搬「起什么」，不搬「怎么起」：下面那 90 行端口逻辑（Test-Port /
#   Get-ListenerPid / Resolve-Port / Test-IsOwnProcess）一行没动。它们是
#   被真机 bug 打磨出来的 Windows 专有知识，重写它们没法保证行为不变。
# ── 起哪几台 ───────────────────────────────────────────────────────────
#   $env:ENGINE_IDS   逗号分隔的 id 列表，例：gpt-sovits,indextts2
#   $env:ENGINE_ID    单台（老写法，继续认；两个都设时 ENGINE_IDS 说了算）
#   两个都不设        = engines\ 下装了的每一台
#
# ⭐ 默认起全部，是为了让「加一台引擎 = 克隆上游 + 写一张 manifest.json +
#   一行代码都不写」这句话真的成立：默认值一旦写死某个 id，第三台引擎的
#   作者就得改这个文件，那就又是一行代码。
# ⛔ 不限制同时起几台，也不在这里判断显存够不够 —— 装了几台是用户的决定，
#   这个脚本没有资格替他删掉一台。
#
# ⚠ 一台起不来**不连累**其余：算不出计划、解释器没装、入口不存在，
#   都只跳过这一台并把原因印出来，后端和别的引擎照常起。
function Get-AllEngineIds {
  $cli = Join-Path $BASE_DIR 'lib\engines\engine-launch-plan.cjs'
  $raw = & $NODE @($cli, '--all') 2>&1
  $txt = ($raw | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    Log ('[engine][ERROR] 列不出装了哪些引擎: {0}' -f $txt) 'Red'
    return @()
  }
  try { $data = $txt | ConvertFrom-Json } catch {
    Log ('[engine][ERROR] 引擎列表不是合法 JSON: {0}' -f $txt) 'Red'
    return @()
  }
  $ids = @()
  foreach ($e in $data.engines) {
    if ($e.ok) { $ids += [string]$e.id }
    else { Log ('[engine][WARN] {0} 的 manifest.json 读不出来，跳过：{1}' -f $e.id, $e.error) 'Yellow' }
  }
  return $ids
}

# 问一次 manifest.json。$Port 给了就按它算命令行，不给就用 manifest.json
# 声明的默认端口。
# ⚠ 纯函数，无副作用，可以放心问两次 —— 第一次拿期望端口去解冲突，
#   解完带着定下来的端口再问一次要最终命令行。
function Get-EnginePlan {
  param([string]$Id, [int]$Port = 0)
  $cli  = Join-Path $BASE_DIR 'lib\engines\engine-launch-plan.cjs'
  $args = @($cli, '--engine', $Id)
  if ($Port -gt 0) { $args += @('--port', "$Port") }
  $raw = & $NODE $args 2>&1
  $txt = ($raw | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    Log ('[engine][ERROR] 算不出 {0} 的启动计划: {1}' -f $Id, $txt) 'Red'
    return $null
  }
  try { return $txt | ConvertFrom-Json } catch {
    Log ('[engine][ERROR] {0} 的启动计划不是合法 JSON: {1}' -f $Id, $txt) 'Red'
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
  param([int]$procId, [string]$baseDir, [string[]]$marks = @())
  if (-not $procId) { return $false }
  $pi  = Get-ProcInfoById -procId $procId
  $hay = (($pi.Path + ' ' + $pi.CommandLine)).ToLowerInvariant()
  if ([string]::IsNullOrWhiteSpace($hay)) { return $false }
  $baseLc    = $baseDir.ToLowerInvariant()
  $underBase = $hay.Contains($baseLc)
  $isBackend = $hay.Contains('server.js')
  # 引擎的记号来自 manifest.json（own_process_mark），一台引擎一个。
  # 拿不到就只认 backend —— 宁可漏认自家引擎（后果是端口往上挪一个，
  # 还能起来），也不要瞎猜一个名字去误伤别人的进程。
  #
  # ⭐⭐ 起多台时这里**必须**只拿「这台自己的」记号来问：
  #   问 A 的端口时如果把 B 的记号也算上，B 恰好占着 A 的端口就会被判成
  #   「A 已经在跑了」⇒ A 永远起不来且不报错。launchPlan.js 第 264-274 行
  #   已经为同一个坑把记号改成了一台一个，这里不能又把它们混回去。
  #   （backend 那次调用**照旧**把所有引擎记号都传进来，与改动前一致。）
  $isEngine = $false
  foreach ($m in $marks) {
    if ($m -and $hay.Contains($m)) { $isEngine = $true; break }
  }
  return ($underBase -and ($isBackend -or $isEngine))
}

# First port >= $startPort with no LISTENER (probe the next free port).
#
# ⚠ $exclude = 本次启动里已经许给别台引擎、但还没开始监听的端口。
#   ⛔ 少了它，两台 manifest.json 写了同一个默认端口时，两台都会被判成
#     「这个端口没人听，free」，然后第二台起来撞死第一台 —— 而 Test-Port
#     问的是「现在有没有人在听」，答不了「等下有没有人要听」。
function Get-FreePort {
  param([int]$startPort, [int]$maxTries = 50, [int[]]$exclude = @())
  for ($p = $startPort; $p -lt ($startPort + $maxTries); $p++) {
    if ($p -gt 65535) { break }
    if ($exclude -contains $p) { continue }
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
  param([string]$name, [int]$desired, [string]$baseDir,
        [string[]]$marks = @(), [int[]]$exclude = @())
  $res = @{ Name = $name; Port = $desired; Action = 'free'; OwnerPid = $null }
  # ⭐ 本次启动里已经有别台认领了这个端口。它还没开始监听，所以 Test-Port
  #   会回答「空闲」—— 那个答案在这里是错的，先单独挡掉，别让它往下走。
  #   ⛔ 也别把它并进下面的 shifted：那条路会印「被陌生进程 pid 占着」，
  #     而这里根本没有陌生进程，pid 是空的。两种情况原因不同，得分开说。
  if ($exclude -contains $desired) {
    $free = Get-FreePort -startPort ($desired + 1) -exclude $exclude
    if ($null -eq $free) { $res.Action = 'exhausted'; return $res }
    $res.Port   = $free
    $res.Action = 'claimed'
    return $res
  }
  # ↓ 以下是改动前的原文，一个字没动。
  if (-not (Test-Port $desired)) { return $res }
  $ownerPid    = Get-ListenerPid -port $desired
  $res.OwnerPid = $ownerPid
  if (Test-IsOwnProcess -procId $ownerPid -baseDir $baseDir -marks $marks) { $res.Action = 'own'; return $res }
  $free = Get-FreePort -startPort ($desired + 1) -exclude $exclude
  if ($null -eq $free) { $res.Action = 'exhausted'; return $res }
  $res.Port   = $free
  $res.Action = 'shifted'
  return $res
}

'==== TTS Broker startup @ {0} ====' -f (Get-Date) | Out-File -FilePath $StartupLog -Encoding UTF8
Log '==================== TTS Broker Startup ====================' 'Cyan'
Log ('root : {0}' -f $BASE_DIR) 'DarkGray'
Log ('node : {0}' -f $NODE) 'DarkGray'

# --- Guard: 这几台引擎装没装 ---
# 搬家前这里查的是写死的 venv\Scripts\python.exe。第三台引擎完全可能用别的
# 解释器（自己的 venv、conda、系统 python），查死一个路径等于规定所有引擎
# 必须共用一个 venv —— 那条规定从来没人同意过，只是写在了这一行里。
if ($env:ENGINE_IDS) {
  $ENGINE_IDS = @($env:ENGINE_IDS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
} elseif ($env:ENGINE_ID) {
  $ENGINE_IDS = @($env:ENGINE_ID.Trim())
} else {
  $ENGINE_IDS = @(Get-AllEngineIds)
}
if ($ENGINE_IDS.Count -eq 0) {
  Log '[engine][ERROR] 一台引擎都没有：engines\ 下没有读得出来的 manifest.json。' 'Red'
  exit 1
}
Log ('[engine] 本次要起 {0} 台：{1}' -f $ENGINE_IDS.Count, ($ENGINE_IDS -join ', ')) 'DarkGray'

# 每台一份记录，后面几段都拿它转：Id / Plan / 端口结论 / 跳不跳过。
$ENGINES = @()
foreach ($eid in $ENGINE_IDS) {
  $plan0 = Get-EnginePlan -Id $eid
  if ($null -eq $plan0) {
    # ⛔ 这里**不 exit**：一台算不出计划，不该把后端和别的引擎一起拖下水。
    Log ('[engine][ERROR] {0}: 拿不到启动计划，跳过这一台。' -f $eid) 'Red'
    continue
  }
  $rec = @{
    Id          = $eid
    Label       = [string]$plan0.label
    Launchable  = ($plan0.launchable -eq $true)
    Mark        = [string]$plan0.own_process_mark
    BaseUrlEnv  = [string]$plan0.base_url_env
    EHost       = [string]$plan0.host
    DesiredPort = [int]$plan0.desired_port
    Port        = [int]$plan0.desired_port
    Action      = 'free'
    OwnerPid    = $null
    Skip        = $false
    SkipReason  = ''
  }
  if ($rec.Launchable) {
    if (-not (Test-Path $plan0.python)) {
      Log ('[engine][ERROR] {0} 的解释器不存在: {1}' -f $eid, $plan0.python) 'Red'
      Log '              这台引擎还没部署（跑一次 首次部署.bat）。跳过它，其余照常起。' 'Red'
      $rec.Skip = $true
      $rec.SkipReason = '解释器不存在'
    }
  } else {
    # manifest.json 没写 runtime = 这台引擎由作者自己起。不是错误，但要说
    # 出来，否则后面"引擎没上线"会看着像 bug。
    Log ('[engine] {0} 不由平台启动（manifest.json 没有 runtime 段），只替它守住端口。' -f $eid) 'Yellow'
  }
  $ENGINES += $rec
}
if ($ENGINES.Count -eq 0) {
  Log '[engine][ERROR] 每一台引擎都拿不到启动计划，无法继续。' 'Red'
  exit 1
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

# ── 先把所有端口定下来，再启动任何东西 ─────────────────────────────────
# 必须排在最前面：后端是从这里继承环境变量的，spawn 之后再改就晚了。
# 某个端口被占、挪走之后，整条链上的人要对得上同一个新号码：
#   * 引擎  : 命令行上收到 -p <port>；后端通过它那个 base_url_env 变量找到它
#             （合成客户端和 /api/health 读的都是这个变量）。
#     ⛔ 变量名不再写死成 GPT_SOVITS_BASE_URL —— 每台引擎在自己的
#       manifest.json 里写 base_url_env 指定，写死一个名字，第二台引擎起来了
#       后端也连不上。
#   * 后端  : 读 $env:BROKER_PORT；浏览器打开挪之后的那个端口。
#   * 前端  : 由后端**同源**伺服（web\dist，web/src/lib/api.js 里 API_BASE=''
#             走相对路径），所以后端端口挪了**不用**往前端注入任何东西，
#             打开新地址就够了。
#
# ⭐ 端口保护对**不可启动**的引擎同样生效：作者自己起的引擎照样占着它那个
#   端口，别的程序就不该占它。所以 host/port 这几样，计划在不可启动时也给。
foreach ($e in $ENGINES) {
  Log ('[engine] {0} ({1}) 期望监听 {2}:{3}' -f $e.Id, $e.Label, $e.EHost, $e.DesiredPort) 'DarkGray'
}

# 本次已经许出去的端口。⛔ 必须一路带着：两台引擎默认端口撞车时，
#   光问「现在有没有人在听」是分不出来的（谁都还没开始听）。
$claimed  = @()
$allMarks = @()
foreach ($e in $ENGINES) { if ($e.Mark) { $allMarks += $e.Mark } }

$portResults = @()
foreach ($e in $ENGINES) {
  # ⭐ 只传这一台自己的记号 —— 理由见 Test-IsOwnProcess 里的那段。
  $r = Resolve-Port -name ('engine ' + $e.Id) -desired $e.DesiredPort -baseDir $BASE_DIR `
                    -marks @($e.Mark) -exclude $claimed
  $e.Port     = [int]$r.Port
  $e.Action   = [string]$r.Action
  $e.OwnerPid = $r.OwnerPid
  $claimed   += [int]$r.Port
  $portResults += $r
}
# backend 这一次**照旧**把所有引擎记号都传进来，与改动前一致。
$backendRes = Resolve-Port -name 'backend' -desired $BACKEND_PORT -baseDir $BASE_DIR `
                          -marks $allMarks -exclude $claimed
$portResults += $backendRes

$exhausted = $false
foreach ($r in @($portResults)) {
  switch ($r.Action) {
    'free'      { Log ('[port] {0}: {1} is free.' -f $r.Name, $r.Port) 'DarkGray' }
    'own'       { Log ('[port] {0}: {1} already held by OUR process (pid {2}) - reuse, skip relaunch.' -f $r.Name, $r.Port, $r.OwnerPid) 'Yellow' }
    'shifted'   { Log ('[port] {0}: desired port busy (foreign pid {1}); shifted -> {2}.' -f $r.Name, $r.OwnerPid, $r.Port) 'Yellow' }
    'claimed'   { Log ('[port] {0}: 本次启动里已有另一台引擎要用这个端口; shifted -> {1}。两台 manifest.json 写了同一个 default_base_url。' -f $r.Name, $r.Port) 'Yellow' }
    'exhausted' { Log ('[port][ERROR] {0}: no free port found near desired. Aborting.' -f $r.Name) 'Red'; $exhausted = $true }
  }
}
if ($exhausted) { exit 1 }
$BACKEND_PORT = [int]$backendRes.Port

# Wire the resolved ports through the whole chain via inherited environment.
$env:BROKER_PORT = "$BACKEND_PORT"
Log ('[port] backend -> {0}  (BROKER_PORT={1})' -f $BACKEND_PORT, $env:BROKER_PORT) 'DarkGray'
foreach ($e in $ENGINES) {
  $url = 'http://{0}:{1}' -f $e.EHost, $e.Port
  if ($e.BaseUrlEnv) {
    # ⛔ 这里过去写死的是 GPT_SOVITS_BASE_URL —— 那是第二台引擎起来了后端
    #   也连不上的直接原因。变量名现在来自这台引擎自己的 manifest.json。
    Set-Item -Path ('Env:' + $e.BaseUrlEnv) -Value $url
    Log ('[port] {0} -> {1}  ({2}={3})' -f $e.Id, $e.Port, $e.BaseUrlEnv, $url) 'DarkGray'
  } else {
    Log ('[port] {0} -> {1}' -f $e.Id, $e.Port) 'DarkGray'
    if ($e.Port -ne $e.DesiredPort) {
      Log ('[port][WARN] {0} 的 manifest.json 没有 base_url_env，而它的端口从 {1} 挪到了 {2}。' -f $e.Id, $e.DesiredPort, $e.Port) 'Red'
      Log ('             后端仍然会去连 {0}，发给这台引擎的合成会失败。' -f $e.DesiredPort) 'Red'
      Log ('             修法：在 engines\{0}\manifest.json 里加一行 "base_url_env"。' -f $e.Id) 'Red'
    }
  }
}

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
# ⛔ 别把它搬回来: 平台已经改成按 manifest.json 起引擎, 启动脚本里不该再有引擎特例。

# 2. Inference engines —— 逐台起
#
# ⚠ 日志文件名改成一台一份：logs\<id>.log / logs\<id>.err.log。
#   起两台之后 logs\inference.log 这个名字答不了「这是哪台的日志」，
#   两台还会同时往同一个文件里写。gpt-sovits 现在写 logs\gpt-sovits.log。
$total = $ENGINES.Count
$idx   = 0
foreach ($e in $ENGINES) {
  $idx += 1
  Log ('[2/2] 引擎 {0}/{1}: {2} on port {3} ...' -f $idx, $total, $e.Id, $e.Port) 'Green'
  if ($e.Skip) {
    Log ('      跳过这一台：{0}。其余照常。' -f $e.SkipReason) 'Red'
    continue
  }
  if (-not $e.Launchable) {
    Log '      这台由作者自己起，平台只替它守住端口。' 'Yellow'
    continue
  }
  if ($e.Action -eq 'own') {
    Log ('      Port {0} already held by OUR engine. Treat engine as running.' -f $e.Port) 'Yellow'
    continue
  }
  # 端口可能被挪过，所以带着定下来的那个再问一次完整计划 ——
  # ⛔ 别用守卫处那份计划的 args：那里面的 -p 还是 manifest.json 上的旧端口，
  #   引擎会听在没人连的地方，表现成「引擎永远不上线」。
  $plan = Get-EnginePlan -Id $e.Id -Port $e.Port
  $ok = ($null -ne $plan) -and $plan.launchable
  if ($ok -and -not (Test-Path $plan.python)) {
    Log ('      [ERROR] 引擎解释器不存在: {0}' -f $plan.python) 'Red'; $ok = $false
  }
  if ($ok -and -not (Test-Path $plan.entry)) {
    Log ('      [ERROR] 引擎入口不存在: {0}' -f $plan.entry) 'Red'; $ok = $false
  }
  if ($ok) {
    $infLog = Join-Path $LogDir ('{0}.log' -f $e.Id)
    $infErr = Join-Path $LogDir ('{0}.err.log' -f $e.Id)
    # 入口在最前，其余参数由 manifest.json 给出（args 里的 {host}/{port} 已展开）。
    $engineArgs = @($plan.entry) + $plan.args
    Log ('      cmd : {0} {1}' -f $plan.python, ($engineArgs -join ' ')) 'DarkGray'
    Log ('      cwd : {0}' -f $plan.cwd) 'DarkGray'
    Start-Process -FilePath $plan.python -ArgumentList $engineArgs -WorkingDirectory $plan.cwd -WindowStyle Hidden -RedirectStandardOutput $infLog -RedirectStandardError $infErr | Out-Null
    Log '      Inference service started in background.' 'Gray'
    # ⚠ 启动脚本**不等**引擎加载完 —— 它起完就走。判断这台引擎上没上线的
    #   是后端：/api/engines 和 /api/health 会去请求下面这个地址。
    #   冷启动几十秒很正常，那段时间里它显示成不在线不是故障。
    Log ('      上线检查地址 {0}；冷启动预算 {1} 秒（本脚本不等它，看后端 /api/health）。' -f $plan.ready_url, [int]($plan.ready_timeout_ms / 1000)) 'DarkGray'
    Log ('      加载进度看 logs\{0}.log / logs\{0}.err.log' -f $e.Id) 'DarkGray'
  }
}

Log '========================================' 'Cyan'
Log ('  UI      : http://127.0.0.1:{0}  opened in browser' -f $BACKEND_PORT) 'Yellow'
Log ('  Backend : http://127.0.0.1:{0}  logs\backend.log' -f $BACKEND_PORT)
foreach ($e in $ENGINES) {
  if ($e.Skip) {
    Log ('  Engine  : {0,-14} 没起（{1}）' -f $e.Id, $e.SkipReason) 'Red'
  } elseif (-not $e.Launchable) {
    Log ('  Engine  : {0,-14} http://{1}:{2}  由作者自己起' -f $e.Id, $e.EHost, $e.Port) 'Yellow'
  } else {
    Log ('  Engine  : {0,-14} http://{1}:{2}  logs\{0}.log' -f $e.Id, $e.EHost, $e.Port)
  }
}
Log '  Launcher will exit. Backend and inference stay running in background.' 'Cyan'
Log '========================================' 'Cyan'
