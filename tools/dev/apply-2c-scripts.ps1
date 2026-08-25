# ============================================================
#  第 2c 步：把引擎知识从 start.ps1 / stop.ps1 搬进名片
#
#  ⛔ 这个脚本**原地替换**，不重写整个文件。理由是我拿不到这两个文件的
#     真实字节：贴进聊天的文本丢了 BOM、行尾、尾随空白，照它重建出来的
#     文件和盘上的不是同一个东西 —— 8/24 那次基线翻车就是这么来的。
#
#  四道闸（每一道都是过去真出过事才加的）：
#    1. 锚点闸：每个锚点必须**恰好出现 1 次**。0 次说明文件已经变了，
#       2 次说明我锚得太松。任何一条对不上 ⇒ 一个字节都不写盘。
#    2. 反向闸：改完之后必须查「不许有什么」—— 光查「该有什么」是
#       8/25 那次真机第一步就崩的原因（18 条断言全在查该有什么）。
#    3. 顺序闸：PowerShell 没有函数提升，顶层调用必须排在定义后面。
#       8/25 第二次事故：前两道闸全绿、sha256 也对上，脚本却一跑就报
#       "Get-ProjectRoot 不识别" —— 文本闸查"写了什么"，查不出运行期
#       的名字解析。这道闸补的正是这一格。
#    4. 备份闸：写盘前把原文件按字节复制成 .2c-backup，写完立刻回读校验。
#
#  ⚠ 编码：整份文件按**字节**读写，BOM 原样带过去，行尾一个不改。
#     PS 5.1 读含中文的 .ps1 靠 BOM 认 UTF-8，丢了 BOM 注释会变乱码。
#
#  用法（在仓库根目录）：
#    .\tools\dev\apply-2c-scripts.ps1            ← 预演，只报告不写盘
#    .\tools\dev\apply-2c-scripts.ps1 -Apply     ← 真写
#    .\tools\dev\apply-2c-scripts.ps1 -Revert    ← 从 .2c-backup 还原
# ============================================================

# ⛔⛔ param() 必须是文件里的**第一条语句** —— 前面只允许注释，不允许任何代码。
#    我第一版把 [Console]::OutputEncoding = ... 放在了它上面，于是 param 不再是
#    第一条语句，PowerShell 把它当成一个叫 "param" 的命令去找，报
#    "The term 'param' is not recognized"。
#    ⚠ 这个错**不会终止脚本** —— 后面照跑，但 -Apply / -Revert 这两个开关
#      压根没被声明，传了也进不来：脚本会一声不响地当成预演跑完，
#      而屏幕上「预演」两个字看着完全正常。开关被静默吞掉比直接报错危险得多。
param(
  [switch]$Apply,
  [switch]$Revert
)

# 放在 param 之后。含中文的输出要靠它才不会在 GBK 控制台变成问号。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = 'Stop'

# 仓库根 = 含 package.json 的那一级，往上走着找。
# ⛔ 绝不按目录层数数：这个文件将来会被挪，层数会「一直工作」但指向别处
#    —— 这条规矩是从 stop.ps1 的 Get-ProjectRoot 抄来的，它已经吃过这个亏。
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

$ROOT = Get-ProjectRoot
if (-not $ROOT) { Write-Host '[FATAL] 找不到仓库根（往上没找到 package.json）' -ForegroundColor Red; exit 1 }
Write-Host ('仓库根: {0}' -f $ROOT) -ForegroundColor DarkGray

$START = Join-Path $ROOT 'tools\scripts\start.ps1'
$STOP  = Join-Path $ROOT 'tools\scripts\stop.ps1'

# --- 按字节读写，BOM 和行尾原样保留 ---------------------------------------
function Read-TextExact {
  param([string]$path)
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $body = if ($bom) { $bytes[3..($bytes.Length - 1)] } else { $bytes }
  $text = [System.Text.Encoding]::UTF8.GetString($body)
  return @{ Text = $text; Bom = $bom }
}

# ⛔⛔ 行尾：这个脚本自己的 .ps1 文件用什么行尾，下面那些 here-string 里的
#   Find 就是什么行尾。而 start.ps1 在工作区里是 CRLF（git 的 autocrlf 干的）。
#   两边对不上 ⇒ IndexOf 一次都找不到 ⇒ 锚点闸报 0x 全红。
#   那样不会写坏文件（闸拦住了），但脚本会变成一个永远不能用的东西，
#   而且报出来的理由是「文件已经和我读到的不一样了」—— 完全误导。
#
#   ⭐ 修法不是"把脚本存成 CRLF"（下次谁编辑一下就又坏了），而是**在运行时
#     把 Find/Replace 的行尾对齐到目标文件的行尾**。只动我要塞进去的字符串，
#     文件其余部分一个字节不碰。
function Get-DominantEol {
  param([string]$text)
  $crlf = ([regex]::Matches($text, "`r`n")).Count
  $lf   = ([regex]::Matches($text, "(?<!`r)`n")).Count
  if ($crlf -ge $lf) { return "`r`n" } else { return "`n" }
}

function Convert-Eol {
  param([string]$text, [string]$eol)
  $lfOnly = $text -replace "`r`n", "`n"
  return ($lfOnly -replace "`n", $eol)
}

function Write-TextExact {
  param([string]$path, [string]$text, [bool]$bom)
  $body = [System.Text.Encoding]::UTF8.GetBytes($text)
  if ($bom) { $body = ([byte[]](0xEF, 0xBB, 0xBF)) + $body }
  [System.IO.File]::WriteAllBytes($path, $body)
}

# ============================================================
#  还原模式
# ============================================================
if ($Revert) {
  $n = 0
  foreach ($f in @($START, $STOP)) {
    $bak = $f + '.2c-backup'
    if (Test-Path -LiteralPath $bak) {
      [System.IO.File]::WriteAllBytes($f, [System.IO.File]::ReadAllBytes($bak))
      Remove-Item -LiteralPath $bak -Force
      Write-Host ('  已还原 {0}' -f (Split-Path $f -Leaf)) -ForegroundColor Green
      $n++
    }
  }
  if ($n -eq 0) { Write-Host '  没有找到 .2c-backup，无事可做。' -ForegroundColor Yellow }
  exit 0
}

# ============================================================
#  替换表
#  Find 是**读实过的原文**；每一条都会先校验「恰好出现一次」。
# ============================================================

$edits = New-Object System.Collections.ArrayList

function Add-Edit {
  param([string]$File, [string]$Name, [string]$Find, [string]$Replace)
  [void]$edits.Add(@{ File = $File; Name = $Name; Find = $Find; Replace = $Replace })
}

# ------------------------------------------------------------
#  start.ps1 —— 四处
# ------------------------------------------------------------

# 【1】变量块：五个写死的 $ENGINE_* 换成「问名片要一份启动计划」。
$find1 = @"
`$ENGINE_PY     = Join-Path `$BASE_DIR 'venv\Scripts\python.exe'
`$ENGINE_SCRIPT = Join-Path `$BASE_DIR 'lib\inference\infer_server.py'
`$ENGINE_CFG    = Join-Path `$BASE_DIR 'lib\inference\tts_infer.yaml'
`$ENGINE_HOST   = '127.0.0.1'
`$ENGINE_PORT   = 9880
"@

$rep1 = @"
# ── 起哪台引擎、拿什么起：问名片，不写在这里 ───────────────────────────
# 搬家前这里躺着五个 `$ENGINE_* 变量，全是 GPT-SoVITS 专有的（解释器、
# 入口、配置文件、监听地址）。它们合起来是一张没写在名片上的名片：
# 第三台引擎的作者会发现名片写完了引擎还是起不来，因为得改这个文件 ——
# 而那正是「加一台引擎不碰 lib/」这条标准要挡住的事。
#
# ⭐ 只搬「起什么」，不搬「怎么起」：下面那 90 行端口逻辑（Test-Port /
#   Get-ListenerPid / Resolve-Port / Test-IsOwnProcess）一行没动。它们是
#   被真机 bug 打磨出来的 Windows 专有知识，重写它们没法保证行为不变。
`$ENGINE_ID = `$env:ENGINE_ID
if (-not `$ENGINE_ID) { `$ENGINE_ID = 'gpt-sovits' }

# 问一次名片。`$Port 给了就按它算命令行，不给就用名片声明的默认端口。
# ⚠ 纯函数，无副作用，可以放心问两次 —— 第一次拿期望端口去解冲突，
#   解完带着定下来的端口再问一次要最终命令行。
function Get-EnginePlan {
  param([int]`$Port = 0)
  `$cli  = Join-Path `$BASE_DIR 'lib\engines\engine-launch-plan.cjs'
  `$args = @(`$cli, '--engine', `$ENGINE_ID)
  if (`$Port -gt 0) { `$args += @('--port', "`$Port") }
  `$raw = & `$NODE `$args 2>&1
  `$txt = (`$raw | Out-String).Trim()
  if (`$LASTEXITCODE -ne 0) {
    Log ('[engine][ERROR] 算不出 {0} 的启动计划: {1}' -f `$ENGINE_ID, `$txt) 'Red'
    return `$null
  }
  try { return `$txt | ConvertFrom-Json } catch {
    Log ('[engine][ERROR] 启动计划不是合法 JSON: {0}' -f `$txt) 'Red'
    return `$null
  }
}
"@

Add-Edit -File 'start' -Name '变量块：五个写死的 $ENGINE_* → Get-EnginePlan' -Find $find1 -Replace $rep1

# 【1b】venv 守卫：查死的 venv\Scripts\python.exe 换成查计划里的解释器。
#
# ⛔⛔ 这一处是**反向闸抓出来的**，不是我想到的。我第一版只搬了【1】那五个
#     赋值，却漏了这里还在读 `$ENGINE_PY —— 变量没了，Test-Path `$null 之后
#     start.ps1 会当场判定"venv Python not found"然后 exit 1，**引擎一次都起不来**。
#     光查「该有什么」的话，五个锚点全绿，这个洞会一路带上真机。
#
# ⚠ 位置有讲究：这里是 start.ps1 里**第一个**同时具备 `$NODE 和 function Log
#   的地方（上面刚解析完 node、刚定义完 Log）。计划在这里算一次存进 `$plan0，
#   下面解端口那一步直接用，不重复起 node 进程。
$find1b = @"
# --- Guard: venv present ---
if (-not (Test-Path `$ENGINE_PY)) {
  Log ('[ERROR] venv Python not found: {0}' -f `$ENGINE_PY) 'Red'
  Log '        Run 首次部署.bat first.' 'Red'
  exit 1
}
"@

$rep1b = @"
# --- Guard: 这台引擎装没装 ---
# 搬家前这里查的是写死的 venv\Scripts\python.exe。第三台引擎完全可能用别的
# 解释器（自己的 venv、conda、系统 python），查死一个路径等于规定所有引擎
# 必须共用一个 venv —— 那条规定从来没人同意过，只是写在了这一行里。
`$plan0 = Get-EnginePlan
if (`$null -eq `$plan0) { Log '[engine][ERROR] 拿不到启动计划，无法继续。' 'Red'; exit 1 }
if (`$plan0.launchable) {
  if (-not (Test-Path `$plan0.python)) {
    Log ('[ERROR] 引擎 {0} 的解释器不存在: {1}' -f `$ENGINE_ID, `$plan0.python) 'Red'
    Log '        Run 首次部署.bat first.' 'Red'
    exit 1
  }
} else {
  # 名片没写 runtime = 这台引擎由作者自己起。不是错误，但要说出来，
  # 否则后面"引擎没上线"会看着像 bug。
  Log ('[engine] {0} 不由平台启动（名片没有 runtime 段）。' -f `$ENGINE_ID) 'Yellow'
}
"@

Add-Edit -File 'start' -Name 'venv 守卫：查死的 python.exe → 计划里的解释器' -Find $find1b -Replace $rep1b

# 【2】认自家进程的记号：写死的 'infer_server.py' 换成计划算出来的。
#     ⭐ 新记号是入口的**绝对路径**（小写），比原来的文件名更严：
#     两台引擎的入口都叫 shim.py 是完全可能的（_TEMPLATE 就是），
#     只比文件名的话，B 引擎占着端口时 A 会被认成"已经在跑"而永远起不来。
$find2 = @"
  `$isBackend = `$hay.Contains('server.js')
  `$isEngine  = `$hay.Contains('infer_server.py')
"@

$rep2 = @"
  `$isBackend = `$hay.Contains('server.js')
  # 引擎的记号来自名片（见 `$ENGINE_PROC_MARK 的赋值处）。拿不到就只认
  # backend —— 宁可漏认自家引擎（后果是端口往上挪一个，还能起来），
  # 也不要瞎猜一个名字去误伤别人的进程。
  `$isEngine  = (`$ENGINE_PROC_MARK -and `$hay.Contains(`$ENGINE_PROC_MARK))
"@

Add-Edit -File 'start' -Name '认自家进程：写死的 infer_server.py → 名片算出的记号' -Find $find2 -Replace $rep2

# 【3】解端口之前先问一次名片，拿到期望端口 + 进程记号。
$find3 = @"
`$engineRes  = Resolve-Port -name 'engine'  -desired `$ENGINE_PORT  -baseDir `$BASE_DIR
"@

$rep3 = @"
# ── 这台引擎想听哪儿、怎么认出它自己的进程（`$plan0 在上面的守卫处已算好）──
# ⭐ 端口保护对**不可启动**的引擎同样生效：作者自己起的引擎照样占着 9880，
#   别的程序就不该占它。所以 host/port 这几样，计划在不可启动时也会给。
`$ENGINE_HOST      = `$plan0.host
`$ENGINE_PORT      = [int]`$plan0.desired_port
`$ENGINE_PROC_MARK = `$plan0.own_process_mark
Log ('[engine] {0} ({1}) 期望监听 {2}:{3}' -f `$ENGINE_ID, `$plan0.label, `$ENGINE_HOST, `$ENGINE_PORT) 'DarkGray'

`$engineRes  = Resolve-Port -name 'engine'  -desired `$ENGINE_PORT  -baseDir `$BASE_DIR
"@

Add-Edit -File 'start' -Name '解端口前先问名片要期望端口 + 进程记号' -Find $find3 -Replace $rep3

# 【4】起进程：命令行从计划里拿，不在这里拼。
$find4 = @"
  `$ok = `$true
  if (-not (Test-Path `$ENGINE_SCRIPT)) { Log ('      [ERROR] Missing infer_server.py: {0}' -f `$ENGINE_SCRIPT) 'Red'; `$ok = `$false }
  if (`$ok) {
    `$infLog = Join-Path `$LogDir 'inference.log'
    `$infErr = Join-Path `$LogDir 'inference.err.log'
    `$engineArgs = @(`$ENGINE_SCRIPT, '-a', `$ENGINE_HOST, '-p', "`$ENGINE_PORT", '-c', `$ENGINE_CFG)
    Start-Process -FilePath `$ENGINE_PY -ArgumentList `$engineArgs -WorkingDirectory `$BASE_DIR -WindowStyle Hidden -RedirectStandardOutput `$infLog -RedirectStandardError `$infErr | Out-Null
    Log '      Inference service started in background.' 'Gray'
    Log '      See logs\inference.log / logs\inference.err.log for loading progress.' 'DarkGray'
  }
"@

$rep4 = @"
  # 端口可能被挪过，所以带着定下来的那个再问一次完整计划 ——
  # ⛔ 别用上面 `$plan0 的 args：那里面的 -p 还是名片上的旧端口，
  #   引擎会听在没人连的地方，表现成「引擎永远不上线」。
  `$plan = Get-EnginePlan -Port `$ENGINE_PORT
  `$ok = (`$null -ne `$plan) -and `$plan.launchable
  if (`$ok -and -not (Test-Path `$plan.python)) {
    Log ('      [ERROR] 引擎解释器不存在: {0}' -f `$plan.python) 'Red'; `$ok = `$false
  }
  if (`$ok -and -not (Test-Path `$plan.entry)) {
    Log ('      [ERROR] 引擎入口不存在: {0}' -f `$plan.entry) 'Red'; `$ok = `$false
  }
  if (`$ok) {
    `$infLog = Join-Path `$LogDir 'inference.log'
    `$infErr = Join-Path `$LogDir 'inference.err.log'
    # 入口在最前，其余参数由名片给出（`$plan.args 里的 {host}/{port} 已展开）。
    `$engineArgs = @(`$plan.entry) + `$plan.args
    Log ('      cmd : {0} {1}' -f `$plan.python, (`$engineArgs -join ' ')) 'DarkGray'
    Log ('      cwd : {0}' -f `$plan.cwd) 'DarkGray'
    Start-Process -FilePath `$plan.python -ArgumentList `$engineArgs -WorkingDirectory `$plan.cwd -WindowStyle Hidden -RedirectStandardOutput `$infLog -RedirectStandardError `$infErr | Out-Null
    Log '      Inference service started in background.' 'Gray'
    Log ('      探活 {0}，预算 {1} 秒。' -f `$plan.ready_url, [int](`$plan.ready_timeout_ms / 1000)) 'DarkGray'
    Log '      See logs\inference.log / logs\inference.err.log for loading progress.' 'DarkGray'
  }
"@

Add-Edit -File 'start' -Name '起进程：命令行/工作目录从计划里拿' -Find $find4 -Replace $rep4

# ------------------------------------------------------------
#  stop.ps1 —— 一处
# ------------------------------------------------------------
#
# ⭐⭐ 这里有一个必须先讲清楚的风险：停止脚本原本**完全不依赖 node**。
#    把端口列表改成"问 node 要"，等于给"停不掉服务"新增了一个失败原因，
#    而停不掉的进程会锁住文件（这个文件顶部的注释记着这笔账）。
#
#    所以做法是：node 问得到就按名片停；问不到就**打一句 warning 继续**，
#    交给第二遍（按项目目录扫进程）兜底 —— 那一遍本来就比按端口停更强，
#    而且它一个外部程序都不用。⛔ 绝不能因为拿不到端口就 exit。

$find5 = @"
`$Ports = @(
  @{ Name = "backend server.js"; Port = 9886 },
  @{ Name = "engine infer_server"; Port = 9880 }
)
"@

$rep5 = @"
# backend 是平台自己的端口，不是引擎知识，留在这里。
`$Ports = @(
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
  `$root = Get-ProjectRoot
  if (-not `$root) { return @() }
  `$node = Join-Path `$root 'tools\runtime\node\node.exe'
  if (-not (Test-Path -LiteralPath `$node)) { `$node = 'node' }
  `$cli = Join-Path `$root 'lib\engines\engine-launch-plan.cjs'
  if (-not (Test-Path -LiteralPath `$cli)) { return @() }
  try {
    `$txt = (& `$node `$cli '--all' 2>&1 | Out-String).Trim()
    if (`$LASTEXITCODE -ne 0) { return @() }
    `$data = `$txt | ConvertFrom-Json
  } catch { return @() }
  `$out = @()
  foreach (`$e in `$data.engines) {
    if (`$e.ok -and `$e.launchable) {
      `$out += @{ Name = ("engine " + `$e.id); Port = [int]`$e.port }
    }
  }
  return `$out
}
"@

Add-Edit -File 'stop' -Name '引擎端口从名片来（拿不到只警告，不退出）' -Find $find5 -Replace $rep5

# ⛔⛔ 2026-08-25 真机事故：这段调用原本跟在 $Ports 旁边（上面那块里），
#    但 Get-EnginePorts 内部要用 Get-ProjectRoot，而后者定义在文件下方 76 行处。
#    PowerShell 顺序执行、函数没有提升 —— 调用点跑在定义点之前，于是每次
#    stop.ps1 都报 "Get-ProjectRoot 不识别"，按端口停引擎那一遍整个失效，
#    全靠第二遍（按项目目录扫进程）兜底才没出事。
#    ⭐ 两道文本闸都查不出这个：锚点闸看到替换发生了、反向闸看到引擎知识没了，
#      两个都绿，而生成的脚本跑不通。为此新增闸③（定义顺序）。
#    ⇒ 调用点挪到标题行之后，那里 Get-ProjectRoot 已经定义过了。
$find5b = @"
Write-Host "==================== TTS Broker Stop ====================" -ForegroundColor Cyan
`$killedAny = `$false
"@

$rep5b = @"
Write-Host "==================== TTS Broker Stop ====================" -ForegroundColor Cyan
`$killedAny = `$false

# ⚠ PS 5.1：函数必须先定义后调用（顺序执行，没有提升）。这段之所以在这里
#    而不是跟着 `$Ports 走，就是因为 Get-EnginePorts 要用上面的 Get-ProjectRoot。
`$enginePorts = Get-EnginePorts
if (`$enginePorts.Count -eq 0) {
  Write-Host "  [WARN] 拿不到引擎端口列表(名片/node)，改由下面第二遍按项目目录清理。" -ForegroundColor Yellow
} else {
  # ⚠ PS 5.1 坑：单元素数组在 += 时会被拆成标量。用 @() 包住再展开。
  foreach (`$ep in @(`$enginePorts)) { `$Ports += `$ep }
}
"@

Add-Edit -File 'stop' -Name '引擎端口的调用点放在 Get-ProjectRoot 定义之后' -Find $find5b -Replace $rep5b

# ============================================================
#  ① 锚点闸 —— 每条恰好一次，否则一个字节都不写
# ============================================================
Write-Host ''
Write-Host '── ① 锚点闸 ────────────────────────────────────────' -ForegroundColor Cyan

$files = @{ start = $START; stop = $STOP }
$srcs  = @{}
foreach ($k in $files.Keys) {
  if (-not (Test-Path -LiteralPath $files[$k])) {
    Write-Host ('[FATAL] 找不到 {0}' -f $files[$k]) -ForegroundColor Red; exit 1
  }
  $srcs[$k] = Read-TextExact $files[$k]
  $srcs[$k].Eol = Get-DominantEol $srcs[$k].Text
  $eolName = if ($srcs[$k].Eol -eq "`r`n") { 'CRLF' } else { 'LF' }
  Write-Host ('  {0,-10} {1} 字符  BOM={2}  行尾={3}' -f $k, $srcs[$k].Text.Length, $srcs[$k].Bom, $eolName) -ForegroundColor DarkGray
}

# 把每条 Find/Replace 的行尾对齐到它要改的那个文件（见 Convert-Eol 上面那段）。
foreach ($e in $edits) {
  $eol = $srcs[$e.File].Eol
  $e.Find    = Convert-Eol -text $e.Find    -eol $eol
  $e.Replace = Convert-Eol -text $e.Replace -eol $eol
}

$bad = 0
foreach ($e in $edits) {
  $text = $srcs[$e.File].Text
  # ⚠ 用 IndexOf 数，不用 -split：Find 里有正则元字符（$ . ( ) [ ]），
  #   -split 会把它们当模式，数出来的次数是错的而且不报错。
  $n = 0; $i = 0
  while ($true) {
    $i = $text.IndexOf($e.Find, $i, [System.StringComparison]::Ordinal)
    if ($i -lt 0) { break }
    $n++; $i += $e.Find.Length
  }
  if ($n -eq 1) {
    Write-Host ('  OK   1x  [{0}] {1}' -f $e.File, $e.Name) -ForegroundColor Green
  } else {
    Write-Host ('  BAD  {0}x  [{1}] {2}' -f $n, $e.File, $e.Name) -ForegroundColor Red
    $bad++
  }
}

if ($bad -gt 0) {
  Write-Host ''
  Write-Host ('[ABORT] {0} 个锚点对不上 —— 没有写任何东西。' -f $bad) -ForegroundColor Red
  Write-Host '        0 次 = 文件已经和我读到的不一样了；2 次 = 我锚得太松。' -ForegroundColor Red
  Write-Host '        两种都不能靠"试着改改看"解决，把这段输出发回来。' -ForegroundColor Red
  exit 1
}

# ============================================================
#  在内存里改
# ============================================================
$out = @{}
foreach ($k in $files.Keys) { $out[$k] = $srcs[$k].Text }
foreach ($e in $edits) {
  $out[$e.File] = $out[$e.File].Replace($e.Find, $e.Replace)
}

# ============================================================
#  ② 反向闸 —— 查「不许有什么」
#  ⛔ 8/25 真机第一步就崩，正是因为 18 条断言全在查「该有什么」。
# ============================================================
Write-Host ''
Write-Host '── ② 反向闸（判据：脚本里不许再有引擎知识）─────────' -ForegroundColor Cyan

$forbidden = @(
  @{ Pat = 'infer_server\.py'; Why = '引擎入口文件名' },
  @{ Pat = '9880';             Why = '引擎端口' },
  @{ Pat = 'tts_infer\.yaml';  Why = '引擎配置文件名' },
  @{ Pat = 'ENGINE_SCRIPT';    Why = '写死的引擎入口变量' },
  @{ Pat = 'ENGINE_CFG';       Why = '写死的引擎配置变量' },
  @{ Pat = 'ENGINE_PY';        Why = '写死的引擎解释器变量' }
)

$leaks = 0
foreach ($k in @('start', 'stop')) {
  foreach ($f in $forbidden) {
    $hits = ([regex]::Matches($out[$k], $f.Pat)).Count
    if ($hits -gt 0) {
      # 注释里提一嘴是允许的（那是解释为什么搬走），代码里出现才算泄漏。
      # 判据：把注释行剥掉再数一次。
      $codeOnly = ($out[$k] -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
      $codeHits = ([regex]::Matches($codeOnly, $f.Pat)).Count
      if ($codeHits -gt 0) {
        Write-Host ('  LEAK [{0}] {1}  ({2}) 在代码里出现 {3} 次' -f $k, $f.Pat, $f.Why, $codeHits) -ForegroundColor Red
        $leaks++
      } else {
        Write-Host ('  ok   [{0}] {1}  只在注释里（{2} 处）' -f $k, $f.Pat, $hits) -ForegroundColor DarkGray
      }
    } else {
      Write-Host ('  ok   [{0}] {1}  一处都没有' -f $k, $f.Pat) -ForegroundColor DarkGray
    }
  }
}

# 正向的也查一遍：端口那 90 行必须还在（只搬"起什么"，不搬"怎么起"）。
$mustKeep = @('Test-Port', 'Get-ListenerPid', 'Resolve-Port', 'Test-IsOwnProcess', 'TIME_WAIT')
foreach ($m in $mustKeep) {
  if ($out['start'] -notmatch [regex]::Escape($m)) {
    Write-Host ('  GONE [start] {0} 不见了 —— 端口逻辑不该被动过' -f $m) -ForegroundColor Red
    $leaks++
  }
}
if ($out['stop'] -notmatch 'Get-ProjectRoot') {
  Write-Host '  GONE [stop] Get-ProjectRoot 不见了' -ForegroundColor Red; $leaks++
}

if ($leaks -gt 0) {
  Write-Host ''
  Write-Host ('[ABORT] 反向闸抓到 {0} 条 —— 没有写任何东西。' -f $leaks) -ForegroundColor Red
  exit 1
}
Write-Host '  反向闸全过。' -ForegroundColor Green

# ============================================================
#  ③ 顺序闸 —— PowerShell 没有函数提升：顶层调用必须在定义之后
#
#  ⛔⛔ 2026-08-25 真机事故催生的第三道闸。stop.ps1 里 Get-EnginePorts 的调用
#     被写在 $Ports 旁边（第 51 行），而它内部要用的 Get-ProjectRoot 定义在
#     第 76 行。锚点闸绿、反向闸绿、写盘成功、sha256 对上 —— 然后一跑就报
#     "Get-ProjectRoot 不识别"，按端口停引擎那一遍整个失效。
#
#  ⭐ 前两道闸查的是**写了什么**，这道闸查的是**跑起来找不找得到**。
#     一个纯文本工具能查出运行期的名字解析问题，值得单独占一道闸。
#
#  ⚠ 不能只查"顶层直接调用"：出事的 Get-ProjectRoot 根本不是顶层调的，
#    是顶层调 Get-EnginePorts、再由它间接调的。必须算传递闭包。
# ============================================================
Write-Host ''
Write-Host '── ③ 顺序闸（PS 没有函数提升）──────────────────────' -ForegroundColor Cyan

function Get-PsOrderFacts {
  param([string]$text)
  $defs  = @{}
  $top   = @()
  $body  = @{}
  $depth = 0
  $stack = New-Object System.Collections.ArrayList
  $lines = $text -split "`r?`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    # ⚠ 先剥字符串再数大括号：这两个脚本里满地都是 "{0,-5}" 这种格式串，
    #   不剥的话括号深度会算飞，函数体的范围整个错位。
    $s = $lines[$i] -replace "'[^']*'", ''
    $s = $s -replace '"[^"]*"', ''
    $s = $s -replace '#.*$', ''
    $cur = $null
    if ($stack.Count -gt 0) { $cur = $stack[$stack.Count - 1].Name }
    if ($s -match '^\s*function\s+([A-Za-z][\w-]*)') {
      $fn = $matches[1]
      if (-not $defs.ContainsKey($fn)) { $defs[$fn] = $i + 1 }
      if (-not $body.ContainsKey($fn)) { $body[$fn] = @{} }
      [void]$stack.Add(@{ Name = $fn; Depth = $depth })
    } else {
      foreach ($m in [regex]::Matches($s, '\b([A-Z][a-z]+-[A-Z][\w]*)\b')) {
        $nm = $m.Groups[1].Value
        if ($null -eq $cur) { $top += @{ Name = $nm; Line = $i + 1 } }
        else { $body[$cur][$nm] = $true }
      }
    }
    $depth += ([regex]::Matches($s, '\{')).Count
    $depth -= ([regex]::Matches($s, '\}')).Count
    if ($depth -lt 0) { $depth = 0 }
    while ($stack.Count -gt 0 -and $depth -le $stack[$stack.Count - 1].Depth) {
      $stack.RemoveAt($stack.Count - 1)
    }
  }
  return @{ Defs = $defs; Top = $top; Body = $body }
}

function Get-CallClosure {
  param([string]$name, [hashtable]$body, [hashtable]$seen)
  if ($seen.ContainsKey($name)) { return }
  $seen[$name] = $true
  if ($body.ContainsKey($name)) {
    foreach ($n in $body[$name].Keys) { Get-CallClosure -name $n -body $body -seen $seen }
  }
}

$orderBad = 0
foreach ($k in @('start', 'stop')) {
  $facts = Get-PsOrderFacts -text $out[$k]
  foreach ($c in $facts.Top) {
    # 名字不在本文件里定义 = 内建 cmdlet，不归这道闸管。
    if (-not $facts.Defs.ContainsKey($c.Name)) { continue }
    $seen = @{}
    Get-CallClosure -name $c.Name -body $facts.Body -seen $seen
    foreach ($g in $seen.Keys) {
      if ($facts.Defs.ContainsKey($g) -and $facts.Defs[$g] -gt $c.Line) {
        if ($g -eq $c.Name) {
          Write-Host ('  ORDER [{0}] 第 {1} 行调用 {2}，但它定义在第 {3} 行' -f $k, $c.Line, $c.Name, $facts.Defs[$g]) -ForegroundColor Red
        } else {
          Write-Host ('  ORDER [{0}] 第 {1} 行调用 {2}，它要用的 {3} 却定义在第 {4} 行' -f $k, $c.Line, $c.Name, $g, $facts.Defs[$g]) -ForegroundColor Red
        }
        $orderBad++
      }
    }
  }
}

if ($orderBad -gt 0) {
  Write-Host ''
  Write-Host ('[ABORT] 顺序闸抓到 {0} 条 —— 没有写任何东西。' -f $orderBad) -ForegroundColor Red
  Write-Host '        PowerShell 顺序执行、函数没有提升：调用点必须排在定义点后面。' -ForegroundColor Red
  exit 1
}
Write-Host '  顺序闸全过。' -ForegroundColor Green

# ============================================================
#  ④ 写盘 + 备份 + 回读校验
# ============================================================
Write-Host ''
if (-not $Apply) {
  Write-Host '── 预演结束：什么都没写 ────────────────────────────' -ForegroundColor Yellow
  Write-Host '   三道闸都过了。真要写的话加 -Apply 再跑一次。' -ForegroundColor Yellow
  exit 0
}

Write-Host '── ④ 写盘 ──────────────────────────────────────────' -ForegroundColor Cyan
foreach ($k in @('start', 'stop')) {
  $f   = $files[$k]
  $bak = $f + '.2c-backup'
  [System.IO.File]::WriteAllBytes($bak, [System.IO.File]::ReadAllBytes($f))
  Write-TextExact -path $f -text $out[$k] -bom $srcs[$k].Bom

  # 回读校验：写进去的是不是我想写的那个（含 BOM）。
  $back = Read-TextExact $f
  if ($back.Text -ne $out[$k]) {
    Write-Host ('  [FATAL] {0} 回读和预期不一致，正在还原。' -f $k) -ForegroundColor Red
    [System.IO.File]::WriteAllBytes($f, [System.IO.File]::ReadAllBytes($bak))
    exit 1
  }
  if ($back.Bom -ne $srcs[$k].Bom) {
    Write-Host ('  [FATAL] {0} 的 BOM 变了，正在还原。' -f $k) -ForegroundColor Red
    [System.IO.File]::WriteAllBytes($f, [System.IO.File]::ReadAllBytes($bak))
    exit 1
  }
  $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  Write-Host ('  写好 {0,-10} BOM={1}  sha256={2}' -f (Split-Path $f -Leaf), $back.Bom, $h) -ForegroundColor Green
}

Write-Host ''
Write-Host '完成。备份在 *.2c-backup（不满意就 -Revert）。' -ForegroundColor Cyan
Write-Host '接下来：先 git --no-pager diff --stat 核一眼，再停服务重启验。' -ForegroundColor Cyan
