#Requires -Version 5.1
# ============================================================
#  Aurivox · 合成结果复用缓存 —— 真机验收
# ============================================================
#
#  这一刀的全部主张只有一句：**同样的输入不该重推第二遍**。
#  下面五轮就是把这句话拆成可证伪的五个数。
#
#  ⭐ 判据是**段数**，不是秒数。段数是离散量，不受真机负载影响，也不需要
#     30 段才成立 —— 所以默认只跑 -Repeat 2（模板 64 字 x2 = 128 字 ≈ 6 段），
#     契约一个字没少，而任务长度和 64 字基准同量级，绕开引擎长任务的不稳定。
#     想复现 45.6 秒那组数字就传 -Repeat 10。
#
#  预期（3070 Laptop + GSV，模板 64 字 = 3 段；耗时模型 ≈ 2.49 秒 + 1.44 秒 x 段数）：
#
#              -Repeat 2（默认，128 字 ≈ 6 段）   -Repeat 10（640 字 = 30 段）
#    轮 1  首次全推      ~11 秒  reuse 0/6         ~45.6 秒  reuse 0/30
#    轮 2  原样重跑      ~2 秒   reuse 6/6         ~2 秒     reuse 30/30  <- 命根子
#    轮 3  改一句        ~4 秒   reuse 5/6         ~3.9 秒   reuse 29/30
#    轮 4  勾强制重推    ~11 秒  reuse 0/6 forced  ~45.6 秒  reuse 0/30
#    轮 5  换 seed       ~11 秒  reuse 0/6         ~45.6 秒  reuse 0/30   <- 防漏输入哨兵
#
#  ⭐ 轮 5 是最要紧的一轮：它若"绿得不该绿"（换了 seed 还复用），说明 seed 根本
#     没进指纹 —— 那是**静默返回错音频**，比崩溃恶劣得多，没有任何日志会提示。
#
#  ⭐⭐ 判定分两批：前一批读 meta.json（被测对象的**自述**），后一批只比对盘上
#     音频的 sha256（**物证**）。两批都过，结论才立得住 —— meta 说"复用了 6 段"
#     而字节说 6 段全是新的，那是统计撒谎；反过来也一样。
#
#  ⛔ 日志一律落 tools\dev\ —— 仓库根有 lib/root_layout.node.test.js 这道反向
#     白名单守卫，根目录多一个未登记文件就会让全量回归红一条。
#
#  用法（在仓库根）：
#      powershell -ExecutionPolicy Bypass -NoProfile -File tools\dev\verify-cache.ps1
#
#  可选：用一次已有的产物当模板（默认自动挑最新的一条）
#      $env:META = 'D:\...\outputs\generate\2026-08-23T17-2_mrgtn\meta.json'

param(
  # 模板文本重复几遍。段数 = 判据的分母，取多少都不影响契约。
  [ValidateRange(2, 50)]
  [int]$Repeat = 2
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root
$LogDir = Join-Path $Root 'tools\dev'
$Log = Join-Path $LogDir 'verify-cache.out.txt'
if (Test-Path $Log) { Remove-Item $Log -Force }

function Say($msg) {
  Write-Host $msg
  Add-Content -Path $Log -Value $msg -Encoding UTF8
}

Say "=== Aurivox 缓存验收 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="
Say "仓库: $Root"

# ---------- 0. 两个进程都得在 ----------
$broker = Get-NetTCPConnection -LocalPort 9886 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
$engine = Get-NetTCPConnection -LocalPort 9880 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty OwningProcess
Say "broker 9886 : $broker"
Say "engine 9880 : $engine"
if (-not $broker) { Say '⛔ broker 没在跑，先 start.bat'; exit 1 }
if (-not $engine) { Say '⛔ 推理引擎没在跑（9880），先 start.bat —— 否则只会看到 ECONNREFUSED'; exit 1 }

# ⭐ 取证：确认这两个进程是**这次**起的，不是跑了三天的旧进程。
#    上一刀就栽在这里：broker 跑了三天没重启，三刀的 HTTP 面从没真验过。
foreach ($pair in @(@('broker', $broker), @('engine', $engine))) {
  $name = $pair[0]; $procId = $pair[1]
  $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
  if ($ci) { Say ("  {0} 启动于 {1}" -f $name, $ci.CreationDate) }
}

# ---------- 1. 找一条既有产物当模板 ----------
$metaPath = $env:META
if (-not $metaPath) {
  $newest = Get-ChildItem (Join-Path $Root 'outputs\generate') -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    ForEach-Object { Join-Path $_.FullName 'meta.json' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  $metaPath = $newest
}
if (-not $metaPath -or -not (Test-Path $metaPath)) {
  Say '⛔ 找不到任何 outputs\generate\*\meta.json —— 先在界面上合成一次，再跑这个脚本'
  exit 1
}
Say "模板 meta : $metaPath"

$m = Get-Content $metaPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $m.recipe) { Say '⛔ 这条产物没有 recipe，换一条'; exit 1 }

# ⛔ $m.recipe 是**引用**不是拷贝：直接改它会把 $m 一起改掉，
#    后面想拿原文就拿不回来了。绕一圈 JSON 做深拷贝。
$template = $m.recipe | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$short = [string]$template.text
if ($short.Length -lt 16) { Say "⚠ 模板文本只有 $($short.Length) 字，太短，量不出差别"; }

function Invoke-Gen($bodyObj, $label) {
  $json = $bodyObj | ConvertTo-Json -Depth 10 -Compress
  # ⛔ PowerShell 5.1 的 -Body <string> 走 latin-1，中文会在传输层烂掉。
  #    必须自己编成 UTF-8 字节数组再发。
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:9886/api/generate' -Method Post `
      -Body $bytes -ContentType 'application/json; charset=utf-8'
  } catch {
    $sw.Stop()
    $detail = $_.ErrorDetails.Message   # ⭐ 正文在这里，不在 $_.Exception.Message
    Say ("✖ {0} 失败 ({1:N1} 秒): {2}" -f $label, $sw.Elapsed.TotalSeconds, $detail)
    throw
  }
  $sw.Stop()
  [pscustomobject]@{
    Label   = $label
    Seconds = $sw.Elapsed.TotalSeconds
    Id      = $r.id
    Segs    = $r.segments.Count
    Meta    = $r
  }
}

function Read-Reuse($id) {
  $p = Join-Path $Root ("outputs\generate\{0}\meta.json" -f $id)
  if (-not (Test-Path $p)) { return $null }
  (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json).reuse
}

# ⭐⭐ 每一段音频的 sha256 —— 这才是真判据，meta 只是嫌疑人的口供。
#
#   为什么字节能当判据：同 seed 同输入**也不是** bit-exact（已实测，GPU 浮点
#   非确定性，384447 点里 53 点差 ±1 LSB）。所以：
#     两次的字节**完全相同** ⇒ 第二次没推理，是从缓存拿的（真复用）
#     两次的字节**不同**     ⇒ 第二次真的推了
#   这条推断只有在"±1 LSB 的随机差异恰好一个都没发生"时才会错，可以忽略。
function Get-SegHashes($id) {
  $p = Join-Path $Root ("outputs\generate\{0}\meta.json" -f $id)
  if (-not (Test-Path $p)) { return @() }
  $meta = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
  $dir = Split-Path -Parent $p
  # ⛔⛔ meta.json 的 `segments` 是**段数（一个数字）**，不是数组 —— 逐段文件在
  #   `files[]` 里，用 `role` 区分（combined / segment），文件名字段叫 `name`
  #   （已经是纯文件名，不用 Split-Path），URL 字段叫 `url`。
  #   我上一版写成 `foreach ($s in $meta.segments)` + `$s.audio_url`：PS 对数字
  #   做 foreach 会迭代一次（值就是那个数字），`$s.audio_url` = $null ⇒
  #   `Split-Path -Leaf ''` 当场抛 ParameterArgumentValidationErrorEmptyString。
  $segs = @($meta.files | Where-Object { $_.role -eq 'segment' } | Sort-Object index)
  if ($segs.Count -eq 0) { return ,([string[]]@()) }
  $out = @()
  foreach ($s in $segs) {
    $f = Join-Path $dir ([string]$s.name)
    if (Test-Path $f) {
      $out += (Get-FileHash $f -Algorithm SHA256).Hash.Substring(0, 12)
    } else {
      $out += '<缺文件>'
    }
  }
  # ⛔ `return $out` 在只有一段时会被 PS 拆成**标量字符串**，之后 $h[0] 取到的
  #    是第一个**字符**，比较全乱。逗号包一层强制它保持数组。
  return ,([string[]]$out)
}

# 两串哈希逐位比，返回相同的下标个数与不同的下标列表。
function Compare-Hashes($a, $b) {
  $a = @($a); $b = @($b)
  $same = 0; $diff = @()
  $n = [Math]::Min($a.Count, $b.Count)
  for ($i = 0; $i -lt $n; $i++) {
    if ($a[$i] -eq $b[$i]) { $same++ } else { $diff += $i }
  }
  [pscustomobject]@{ Same = $same; Diff = $diff; N = $n }
}

function Report($res) {
  $reuse = Read-Reuse $res.Id
  if ($reuse) {
    $line = "{0,-14} {1,6:N1} 秒  {2,3} 段  复用 {3}/{4}  forced={5}  id={6}" -f `
      $res.Label, $res.Seconds, $res.Segs, $reuse.reused_segments, $reuse.total_segments,
      $reuse.forced, $res.Id
  } else {
    $line = "{0,-14} {1,6:N1} 秒  {2,3} 段  ⚠ meta 里没有 reuse 字段  id={3}" -f `
      $res.Label, $res.Seconds, $res.Segs, $res.Id
  }
  Say $line
  return $reuse
}

# ⭐⭐ 每次跑都换一枚随机记号，掺进本次用到的**每一句**里。
#   两个理由，缺一不可：
#   1. 预热是 force_resynth=$true —— 它**只跳过读、不跳过写**，所以预热用过的
#      文本会进缓存。上一版预热直接用模板原文，而模板恰好是上次跑出来的产物，
#      其文本又恰好等于本次长文的第 0 段 ⇒ 轮 1 seg0 命中预热刚写的条目，
#      "轮1 一段都没复用" 当场变红。那**不是 bug，是我喂的数据自己撞了**。
#   2. 没有记号的话，这个脚本**跑第二遍**时缓存里全是上一遍的条目 ⇒
#      轮 1 会 4/4 全命中。"首次全推" 这条判据只在头一遍成立 —— 一次性判据
#      等于没有判据。
$nonce = '{0:x6}' -f (Get-Random -Maximum 0xffffff)

# ---------- 2. 预热（丢弃） ----------
$body = $template | ConvertTo-Json -Depth 10 | ConvertFrom-Json
# 预热文本刻意与验收长文的任何一句都不同（并带上本次记号），免得预热把
# 验收要用的段提前写进缓存。
$body.text = ("ウォームアップ{0}のための捨てる一文です。" -f $nonce)
$body.seed = 12345
$body | Add-Member -NotePropertyName force_resynth -NotePropertyValue $true -Force
$body.engine_batch = $false
Say ''
Say '预热中（结果丢弃，只为把冷启动开销赶走）...'
$null = Invoke-Gen $body '预热'

# ---------- 3. 五轮 ----------
# ⛔⛔ 这里曾经写的是 `$short * $Repeat` —— 把同一句话重复 N 遍。
#   那是**退化数据**：切完之后 N 段文本一模一样 ⇒ N 段同指纹 ⇒
#   第 1 段未命中、后 N-1 段全部命中**是完全正确的行为**。
#   于是轮 1「首次全推 reuse 0/N」这条判据在正确实现上也永远不成立，
#   而且轮 3「只有变了的那段该重推」根本无从谈起（每段都一样，谈不上"哪一段"）。
#   ⭐ 缓存的验收数据**必须每段都不同** —— 否则量的是"重复句子会不会复用"，
#      而不是"同一次请求重跑会不会复用"。
#
# ⛔ 第二个坑（同样是我的）：`-Repeat` 原本的语义是"模板 64 字重复几遍"，
#   换成自造短句之后我却直接拿它当**句数**用 ⇒ -Repeat 2 只有 36 字，
#   低于 softLimit 根本不分段（1 段），五轮判据全部落空。
#   ⭐ 现在改成按**目标字数**造句：凑够 64 x Repeat 字为止，
#      于是 -Repeat 2 ≈ 128 字 ≈ 6 段、-Repeat 10 ≈ 640 字 ≈ 30 段，
#      与文件头那张预期表重新对上。
$targetChars = 64 * $Repeat
$parts = @()
$i = 0
while ((($parts -join '').Length) -lt $targetChars) {
  $i++
  $parts += ("これは検証用の第{0}文{1}です。" -f $i, $nonce)
}
$long = -join $parts
Say ''
Say ("长文 {0} 字（{1} 句互不相同的短句，目标 {2} 字）" -f $long.Length, $parts.Count, $targetChars)
Say '  ⚠ 故意不用模板原文重复拼 —— 重复句会让每段文本相同，判据全部失去意义'
Say ''

$body.text = $long
$body.force_resynth = $false

Say '轮 1  首次全推 —— 缓存里什么都没有'
$res1 = Invoke-Gen $body '轮1 首次'
$r1 = Report $res1
$h1 = Get-SegHashes $res1.Id

# ⭐ 数据体检：轮 1 的各段音频必须互不相同。若有重复，说明切出来的段文本撞了，
#   后面所有判据都会失去意义 —— 与其给出一份看不懂的报告，不如当场停。
$dupes = @($h1 | Group-Object | Where-Object { $_.Count -gt 1 })
if ($dupes) {
  Say ''
  Say '⛔ 轮 1 里有若干段音频完全相同 —— 测试数据退化了（切出来的段文本撞了）。'
  Say '   在这种数据上，"复用"和"这两段本来就该一样"是分不开的，判据全部作废。'
  Say ("   重复的哈希: {0}" -f (($dupes | ForEach-Object { $_.Name }) -join ', '))
  exit 1
}

Say ''
Say '轮 2  原样重跑 —— ⭐ 这一轮是全刀的命根子，必须 100% 复用'
$res2 = Invoke-Gen $body '轮2 重跑'
$r2 = Report $res2
$h2 = Get-SegHashes $res2.Id

Say ''
Say '轮 3  改最后一句 —— 只有变了的那一段该重推'
$parts3 = $parts.Clone()
$parts3[$parts3.Count - 1] = ("これは差し替えた最後の一文{0}です。" -f $nonce)
$body.text = -join $parts3
$res3 = Invoke-Gen $body '轮3 改一句'
$r3 = Report $res3
$h3 = Get-SegHashes $res3.Id

Say ''
Say '轮 4  勾上 Force re-synthesis —— 该退回全推'
$body.text = $long
$body.force_resynth = $true
$res4 = Invoke-Gen $body '轮4 强制重推'
$r4 = Report $res4
$h4 = Get-SegHashes $res4.Id

Say ''
Say '轮 5  换一个 seed —— 证明 seed 真的进了指纹（没漏输入）'
$body.force_resynth = $false
$body.seed = 999
$res5 = Invoke-Gen $body '轮5 换seed'
$r5 = Report $res5
$h5 = Get-SegHashes $res5.Id

# ---------- 4. 判定 ----------
Say ''
Say '=== 判定 ==='
$fail = 0
function Check($ok, $msg) {
  if ($ok) { Say "  ✔ $msg" } else { Say "  ✖ $msg"; $script:fail++ }
}

Check ($null -ne $r1) 'meta.json 里有 reuse 字段（留痕）'
if ($r1) { Check ($r1.reused_segments -eq 0) "轮1 一段都没复用（实际 $($r1.reused_segments)）" }
if ($r2) {
  Check ($r2.reused_segments -eq $r2.total_segments) `
    "轮2 全部复用 $($r2.reused_segments)/$($r2.total_segments)"
}
if ($r3) {
  Check ($r3.reused_segments -eq ($r3.total_segments - 1)) `
    "轮3 只重推了变掉的那一段（复用 $($r3.reused_segments)/$($r3.total_segments)）"
}
if ($r4) {
  Check ($r4.forced -eq $true) '轮4 meta 记下了 forced=true'
  Check ($r4.reused_segments -eq 0) "轮4 强制重推后一段都没复用（实际 $($r4.reused_segments)）"
}
if ($r5) {
  Check ($r5.reused_segments -eq 0) `
    "轮5 换 seed 后一段都没复用（实际 $($r5.reused_segments)）—— 若这条红，说明 seed 没进指纹"
}

# ---------- 4b. 逐字节核验：不信 meta，只信字节 ----------
# ⭐⭐ 上面那一批判据全部读的是 meta.json ——那是**被测对象的自述**。
#   它说"复用了 6 段"，可它凭什么？下面这批判据一个字都不看 meta，
#   只比对盘上的音频字节。两边都过，结论才立得住。
Say ''
Say '=== 逐字节核验（不看 meta，只比对盘上音频）==='

$c21 = Compare-Hashes $h2 $h1
Check ($c21.Same -eq $c21.N -and $c21.N -gt 0) `
  "轮2 每一段都和轮1 逐字节相同（$($c21.Same)/$($c21.N)）—— 字节相同才证明真的没重推"

$c31 = Compare-Hashes $h3 $h1
# ⛔ 空管道的结果是 $null，`.Count` 在 $null 上不可靠 —— 一律 @() 包一层。
$early = @($c31.Diff | Where-Object { $_ -lt ($c31.N - 1) })
$prefixOk = (@($c31.Diff).Count -gt 0) -and ($early.Count -eq 0)
Check $prefixOk `
  ("轮3 只有末尾变了的段不同，前面各段逐字节不变（不同的段: {0}）" -f `
    (($c31.Diff -join ',') -replace '^$', '无'))

$c41 = Compare-Hashes $h4 $h1
Check ($c41.Same -eq 0 -and $c41.N -gt 0) `
  "轮4 强制重推后没有任何一段和轮1 字节相同（相同 $($c41.Same)/$($c41.N)）"

$c51 = Compare-Hashes $h5 $h1
Check ($c51.Same -eq 0 -and $c51.N -gt 0) `
  "轮5 换 seed 后没有任何一段和轮1 字节相同（相同 $($c51.Same)/$($c51.N)）"

# ⭐ meta 的口供必须和字节对得上。CR 报过"meta 计数虚高"，就靠这条钉死：
#   字节说复用了几段，meta 就得说几段，一个不差。
if ($r2) {
  Check ($r2.reused_segments -eq $c21.Same) `
    "轮2 meta 自报的复用段数($($r2.reused_segments))与字节实测($($c21.Same))一致"
}
if ($r5) {
  Check ($r5.reused_segments -eq $c51.Same) `
    "轮5 meta 自报的复用段数($($r5.reused_segments))与字节实测($($c51.Same))一致"
}

Say ''
Say '各轮逐段哈希（前 12 位）：'
# ⛔ 不能写成 @(@('轮1', $h1), ...) —— PS 会把内层的 $h1 **摊平**进外层，
#    $pair[1] 就只剩第一个哈希了。用对象把两者绑在一起才不会被摊开。
$table = @(
  [pscustomobject]@{ Name = '轮1'; H = $h1 }
  [pscustomobject]@{ Name = '轮2'; H = $h2 }
  [pscustomobject]@{ Name = '轮3'; H = $h3 }
  [pscustomobject]@{ Name = '轮4'; H = $h4 }
  [pscustomobject]@{ Name = '轮5'; H = $h5 }
)
foreach ($row in $table) {
  Say ("  {0}  {1}" -f $row.Name, (@($row.H) -join '  '))
}

# ⭐ 时间只做**参考**，不做判定：真机负载、显存占用、别的进程都会影响它。
#   真正的判据是上面那些**段数** —— 离散、可复现、不受负载影响。
Say ''
Say '耗时（仅供参考，判定不看它）：'
foreach ($res in @($res1, $res2, $res3, $res4, $res5)) {
  Say ("  {0,-12} {1,6:N1} 秒" -f $res.Label, $res.Seconds)
}
if ($res1.Seconds -gt 0) {
  Say ("  轮2 相对轮1 省了 {0:N0}%" -f ((1 - $res2.Seconds / $res1.Seconds) * 100))
  Say ("  轮3 相对轮1 省了 {0:N0}%" -f ((1 - $res3.Seconds / $res1.Seconds) * 100))
}

# ---------- 5. force_resynth 不该被存进 recipe ----------
# 否则那一次产物的 Rerun 按钮会永远绕开缓存 —— 而 Rerun 恰恰最该命中。
Say ''
Say '=== Rerun 不会被钉成永久强制重推 ==='
$p4 = Join-Path $Root ("outputs\generate\{0}\meta.json" -f $res4.Id)
if (Test-Path $p4) {
  $m4 = Get-Content $p4 -Raw -Encoding UTF8 | ConvertFrom-Json
  $inRecipe = $null -ne $m4.recipe.PSObject.Properties['force_resynth']
  Check (-not $inRecipe) 'force_resynth 没有被写进 recipe（Rerun 仍能复用）'
  Check ($m4.reuse.forced -eq $true) '同一次的 meta.reuse.forced 仍然记着 true（现场可查）'
} else {
  Say "  ⚠ 找不到 $p4，跳过这一项"
}

Say ''
if ($fail -eq 0) {
  Say "全部通过。日志: $Log"
  exit 0
} else {
  Say "⛔ $fail 项未通过。日志: $Log"
  exit 1
}
