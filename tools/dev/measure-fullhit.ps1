#Requires -Version 5.1
<#
  measure-fullhit.ps1 —— 全命中到底慢在哪（只量，不改任何代码）

  背景：我此前写下「全命中仍 ~2 秒（30 次读 + concat）」，那是**推测，没量过**。
  沙箱实测把它推翻了：30 段的本地流水线（读缓存 + 归一 + 写分段 + 拼接 + 算时长）
  合计只有 31 毫秒，60 段 43 毫秒。所以若真机上全命中真要 ~2 秒，那 2 秒
  **不在这段代码里**，得先定位再决定要不要动刀。

  这个脚本把全命中的耗时拆成四块：

    B  全命中（concat=true）      ← 传说中的那 2 秒
    C  全命中（concat=false）     ← 同一条路，但不拼接
    B - C                         ⇒ 拼接（含 ffmpeg 进程启动）的账
    F  直接跑一次 ffmpeg 拼接      ⇒ 单独验证上面那个差值
    H  /api/health 往返 × 5 取平均 ⇒ HTTP + 进程固定开销的地板

  ⚠ 只读：不改仓库任何文件。会通过正常 API 产生几条 outputs\generate\ 产物
     （和你在界面上点合成没有区别），日志写在 tools\dev\ 下。

  用法：  .\tools\dev\measure-fullhit.ps1
  可选：  $env:SENTENCES = '30'   # 造多少句（默认 30）

  ------------------------------------------------------------------
  ⭐ 关于读数：measure-fullhit.out.txt 不进仓库（.gitignore 里排掉了）。
     每跑一次那些数就变，把上次的读数当事实引用比没有读数更危险。
     所以「怎么把这个数重新量出来」写在这里，而不是靠留着输出文件：

       1. .\tools\scripts\start.ps1        —— 两个进程都要在（9886 / 9880）
       2. 在界面上正常合成一次              —— 脚本要拿一条 meta.json 的
                                              recipe 当模板（也可 $env:META 指定）
       3. .\tools\dev\measure-fullhit.ps1  —— 结果同时打屏 + 写 out.txt

     前提：缓存本身是好的。若 B 那步报「没有全命中」，先跑 verify-cache.ps1，
     不要在这里找原因。

     ⛔ 引用读数时必须连着机器一起说（本项目基线：3070 Laptop / GSV）。
        换一台机器、换一个引擎，这些数一个都不成立。
  ------------------------------------------------------------------
#>

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Log  = Join-Path $PSScriptRoot 'measure-fullhit.out.txt'
if (Test-Path $Log) { Remove-Item $Log -Force }

function Say($msg) {
  Write-Host $msg
  Add-Content -Path $Log -Value $msg -Encoding UTF8
}

Say "=== 全命中耗时定位 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Say "仓库: $Root"

# ---------- 0. 两个进程都得在，且要知道是什么时候起的 ----------
$broker = Get-NetTCPConnection -LocalPort 9886 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
$engine = Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
if (-not $broker) { Say '⛔ broker 没在跑（9886），先 start.bat'; exit 1 }
if (-not $engine) { Say '⛔ 推理引擎没在跑（9880），先 start.bat'; exit 1 }
Say "broker 9886 : $broker    engine 9880 : $engine"
foreach ($pair in @(@('broker', $broker), @('engine', $engine))) {
  $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$($pair[1])" -ErrorAction SilentlyContinue
  if ($ci) { Say ("  {0} 启动于 {1}" -f $pair[0], $ci.CreationDate) }
}

# ---------- 1. 拿一条既有产物的 recipe 当模板 ----------
$metaPath = $env:META
if (-not $metaPath) {
  $metaPath = Get-ChildItem (Join-Path $Root 'outputs\generate') -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'meta.json' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}
if (-not $metaPath -or -not (Test-Path $metaPath)) {
  Say '⛔ 找不到任何 outputs\generate\*\meta.json —— 先在界面上合成一次'; exit 1
}
Say "模板 meta : $metaPath"
$m = Get-Content $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $m.recipe) { Say '⛔ 这条产物没有 recipe，换一条'; exit 1 }
# ⛔ $m.recipe 是引用不是拷贝，绕一圈 JSON 深拷贝
$template = $m.recipe | ConvertTo-Json -Depth 10 | ConvertFrom-Json

# ---------- 2. 造长文：每句都不一样 ----------
# ⛔ 绝不能用同一句重复拼 —— 段文本相同会让指纹相同，全命中这件事就没意义了。
$count = if ($env:SENTENCES) { [int]$env:SENTENCES } else { 30 }
$stamp = Get-Date -Format 'HHmmss'
$sentences = 1..$count | ForEach-Object {
  "第{0}段测试文本编号{1}{0}号，内容彼此不同，用于测量全命中的固定开销。" -f $_, $stamp
}
$longText = ($sentences -join '')
Say ""
Say ("长文 {0} 字（{1} 句互不相同）" -f $longText.Length, $count)

function New-Body($text, $doConcat) {
  $b = $template | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $b.text = $text
  if ($null -ne $b.PSObject.Properties['force_resynth']) { $b.force_resynth = $false }
  else { $b | Add-Member -NotePropertyName force_resynth -NotePropertyValue $false -Force }
  $b | Add-Member -NotePropertyName concat -NotePropertyValue $doConcat -Force
  $b
}

function Invoke-Gen($bodyObj, $label) {
  $json  = $bodyObj | ConvertTo-Json -Depth 10 -Compress
  # ⛔ PS 5.1 的 -Body <string> 走 latin-1，中文会在传输层烂掉；必须自己编 UTF-8。
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9886/api/generate' -Method Post `
      -Body $bytes -ContentType 'application/json; charset=utf-8'
  } catch {
    $sw.Stop()
    Say ("✖ {0} 失败 ({1:N2} 秒): {2}" -f $label, $sw.Elapsed.TotalSeconds, $_.ErrorDetails.Message)
    throw
  }
  $sw.Stop()
  $meta = $null
  $p = Join-Path $Root ("outputs\generate\{0}\meta.json" -f $r.id)
  if (Test-Path $p) { $meta = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json }
  [pscustomobject]@{
    Label = $label; Seconds = $sw.Elapsed.TotalSeconds; Id = $r.id
    Reused = if ($meta -and $meta.reuse) { [int]$meta.reuse.reused_segments } else { -1 }
    Total  = if ($meta -and $meta.reuse) { [int]$meta.reuse.total_segments }  else { -1 }
    Dir    = Join-Path $Root ("outputs\generate\{0}" -f $r.id)
  }
}

function Show($res) {
  Say ("  {0,-26} {1,7:N2} 秒   复用 {2}/{3}   id={4}" -f `
    $res.Label, $res.Seconds, $res.Reused, $res.Total, $res.Id)
}

# ---------- 3. 预热（结果丢弃，把冷启动赶走） ----------
Say ""
Say "预热中（结果丢弃）..."
$null = Invoke-Gen (New-Body ("预热{0}，这一条不算数。" -f $stamp) $true) '预热'

# ---------- 4. A 首次全推（把缓存填满） ----------
Say ""
Say "A 首次全推 —— 只为把缓存填满，耗时不是本次关注点"
$A = Invoke-Gen (New-Body $longText $true) 'A 首次全推'
Show $A
if ($A.Total -lt 2) {
  Say ("⛔ 只切出 {0} 段，量不出名堂。把 SENTENCES 调大，或检查 recipe 里的 max_chars/split" -f $A.Total)
  exit 1
}

# ---------- 5. B 全命中（concat=true）★ 本次主角 ----------
Say ""
Say "B 原样重跑 —— 全命中，带拼接 ★"
$B = Invoke-Gen (New-Body $longText $true) 'B 全命中(拼接)'
Show $B
if ($B.Reused -ne $B.Total) {
  Say ("⛔ 没有全命中（{0}/{1}），这次测量作废 —— 先跑 verify-cache.ps1 确认缓存是好的" -f $B.Reused, $B.Total)
  exit 1
}

# ---------- 6. C 全命中（concat=false） ----------
Say ""
Say "C 原样重跑 —— 全命中，但不拼接（B 减 C 就是拼接的账）"
$C = Invoke-Gen (New-Body $longText $false) 'C 全命中(不拼接)'
Show $C

# ---------- 7. H：HTTP 往返地板 ----------
$hs = @()
1..5 | ForEach-Object {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try { $null = Invoke-RestMethod -Uri 'http://127.0.0.1:9886/api/health' -Method Get } catch {}
  $sw.Stop(); $hs += $sw.Elapsed.TotalSeconds
}
$H = ($hs | Measure-Object -Average).Average

# ---------- 8. F：直接跑一次 ffmpeg 拼接，单独验证拼接的账 ----------
$F = $null
$ff = Join-Path $Root 'vendor\ffmpeg\windows-x86_64\ffmpeg.exe'
if (-not (Test-Path $ff)) { $ff = 'ffmpeg' }
$segs = @(Get-ChildItem $B.Dir -Filter 'seg*.wav' -File -ErrorAction SilentlyContinue | Sort-Object Name)
if ($segs.Count -ge 2) {
  $listFile = Join-Path $env:TEMP ("aurivox-concat-{0}.txt" -f $stamp)
  $outFile  = Join-Path $env:TEMP ("aurivox-concat-{0}.wav" -f $stamp)

  # ⛔⛔ 这里绝不能用 Set-Content -Encoding UTF8：PS 5.1 的 "UTF8" 是**带 BOM** 的。
  #     ffmpeg 的 concat demuxer 逐行做纯文本解析，BOM 会粘在第一行开头，于是
  #     第一行不是 file 而是 "\uFEFFfile"，报 unknown keyword 'file' ——
  #     错误信息里那个 BOM 是不可见字符，看起来就像 ffmpeg 在无理取闹。
  #     WriteAllLines + UTF8Encoding($false) 才是无 BOM。
  #     ⭐ 注意区分：**这个 .ps1 文件自己必须带 BOM**（PS 5.1 读无 BOM 的脚本
  #        会按系统 ANSI 解码，上面的中文全变乱码）。带不带 BOM 是按文件用途
  #        决定的，不是一个可以全局统一的口味。
  $listLines = @($segs | ForEach-Object { "file '{0}'" -f $_.FullName.Replace("'", "'\''") })
  [System.IO.File]::WriteAllLines($listFile, $listLines, (New-Object System.Text.UTF8Encoding($false)))

  # 写完自己验一遍：谁哪天手滑改回 Set-Content，在这里当场炸，
  # 而不是让 ffmpeg 去报一句没人看得懂的话。
  $head = [System.IO.File]::ReadAllBytes($listFile)
  if ($head.Length -ge 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
    Say '⛔ concat 列表带上了 BOM —— ffmpeg 会报 unknown keyword ''file''。'
    Say '   写这个列表必须用 [System.IO.File]::WriteAllLines(..., UTF8Encoding($false))。'
    Remove-Item $listFile -Force -ErrorAction SilentlyContinue
    exit 1
  }

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & $ff -hide_banner -loglevel error -y -f concat -safe 0 -i $listFile -c copy $outFile 2>&1 | Out-Null
  $sw.Stop(); $F = $sw.Elapsed.TotalSeconds
  Remove-Item $listFile, $outFile -Force -ErrorAction SilentlyContinue
}

# ---------- 9. 结账 ----------
Say ""
Say "=== 拆账（段数 $($B.Total)）==="
Say ("  B 全命中(拼接)        {0,7:N2} 秒   ← 传说中的那 2 秒" -f $B.Seconds)
Say ("  C 全命中(不拼接)      {0,7:N2} 秒" -f $C.Seconds)
Say ("  B - C = 拼接的账      {0,7:N2} 秒" -f ($B.Seconds - $C.Seconds))
if ($null -ne $F) {
  Say ("  F 单跑 ffmpeg 拼接    {0,7:N2} 秒   ← 若与 B-C 接近，账就坐实在 ffmpeg 进程上" -f $F)
} else {
  Say  "  F 单跑 ffmpeg 拼接      跳过（分段文件不足 2 个，或 concat=false 那次没产分段）"
}
Say ("  H /api/health 往返    {0,7:N3} 秒   ← HTTP + 进程固定开销的地板" -f $H)
$residual = $C.Seconds - $H
Say ("  C - H = 剩下的        {0,7:N2} 秒   ← 读缓存/归一/写分段/算时长/switchModels 都在这里" -f $residual)
Say ""
Say "参照：沙箱实测同样 30 段的本地流水线（读+归一+写+拼接+算时长）合计 0.031 秒。"
Say "     若上面 C - H 远大于这个数，说明大头在 switchModels 那次引擎握手或别处，"
Say "     不在缓存这条路上 —— 那就不该在缓存里改。"
Say ""
Say "日志: $Log"
