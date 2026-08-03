<#
  apply_patch.ps1 — apply an Aurivox 1.0.6 patch safely, with backup.

  One combined patch for the whole 1.0.6 release (11 files, +349/-14):
    aurivox-1.0.6.patch
      backend  : package.json, lib/http/http.js, lib/util/mutex.js, server.js,
                 lib/inference/TTS.py, lib/routes/synthesis.js
      frontend : web/src/components/common/Fields.jsx,
                 web/src/components/generate/GenerateTab.jsx,
                 web/src/components/compare/ReferenceCompareTab.jsx
                 (rebuild web after applying)
      docs     : README.md, GUIDANCE.md
  (The touched-file list is derived from the patch itself, so this script also
   works for any other Aurivox patch you point it at with -Patch.)

  Flow:
    1) auto-detect repo root (walks up to the folder containing package.json)
    2) SPLIT the patch into two groups and `git apply --check` each separately:
         CODE (.js/.py/.json/.jsx) = HARD requirement — mismatch ABORTS
         DOCS (*.md, e.g. README/GUIDANCE) = best-effort — mismatch is SKIPPED
       (so a stray keystroke in a .md never blocks the code update). Each group
       also detects "already applied" via a reverse-check.
    3) print WHAT'S NEW (the 1.0.6 features), show the two-group plan, and ASK
       to proceed (skip with -Yes)
    4) physical backup of the files about to change to .patch-backup\<timestamp>\
    5) `git apply` each group independently, then tell you if a frontend rebuild
       is needed

  Usage (double-click 应用更新_apply.bat, or):
    powershell -ExecutionPolicy Bypass -File apply_patch.ps1          # applies aurivox-1.0.6.patch
    powershell -ExecutionPolicy Bypass -File apply_patch.ps1 -Yes     # no confirmation prompt

  Rollback anytime with rollback_patch.ps1 (git reverse, or -From <backupDir>).
#>
[CmdletBinding()]
param(
  [string]$Patch = "aurivox-1.0.6.patch",
  [string]$RepoRoot = ".",
  [switch]$Yes   # skip the interactive confirmation (non-interactive apply)
)

$ErrorActionPreference = "Stop"

function Fail($msg) { Write-Host "[apply] ERROR: $msg" -ForegroundColor Red; exit 1 }

# Walk up from a start dir looking for package.json (the repo root marker).
function Find-RepoRoot($start) {
  $d = (Resolve-Path $start).Path
  while ($d) {
    if (Test-Path (Join-Path $d "package.json")) { return $d }
    $p = Split-Path $d -Parent
    if ($p -eq $d) { break }
    $d = $p
  }
  return $null
}

# Derive the touched-file list FROM the patch itself (git '+++ b/<path>' headers),
# so this one script works for any Aurivox patch (backend or frontend).
function Get-PatchFiles($patchPath) {
  $files = @()
  foreach ($line in Get-Content -LiteralPath $patchPath) {
    if ($line -match '^\+\+\+\s+b/(.+)$') { $files += ($Matches[1] -replace '/', '\') }
  }
  return ($files | Select-Object -Unique)
}

# --- 1) locate repo root + patch ------------------------------------------
# Auto-detect repo root: try the given -RepoRoot, else walk up from the
# current dir, else walk up from this script's dir (handles double-clicked .bat).
$found = Find-RepoRoot $RepoRoot
if (-not $found) { $found = Find-RepoRoot (Get-Location).Path }
if (-not $found -and $PSScriptRoot) { $found = Find-RepoRoot $PSScriptRoot }
if (-not $found) { Fail "could not locate repo root (no package.json found from '$RepoRoot', cwd, or script dir). Place these files inside the Aurivox folder, or pass -RepoRoot <path>." }
$RepoRoot = $found
Set-Location $RepoRoot

if (-not (Test-Path $Patch)) {
  # also try alongside this script
  $alt = Join-Path $PSScriptRoot (Split-Path $Patch -Leaf)
  if (Test-Path $alt) { $Patch = $alt } else { Fail "patch file not found: $Patch" }
}
$Patch = (Resolve-Path $Patch).Path
$Touched = @(Get-PatchFiles $Patch)
if ($Touched.Count -eq 0) { Fail "no target files found in patch (no '+++ b/...' headers): $Patch" }
$TouchesFrontend = [bool]($Touched | Where-Object { $_ -like 'web\*' })
Write-Host "[apply] repo : $RepoRoot"
Write-Host "[apply] patch: $Patch"

$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)
if (-not $hasGit) { Fail "git not found on PATH — this patch is applied with 'git apply'. Install Git for Windows." }

# informational version print (only warn about 1.0.6 if this patch bumps package.json)
try {
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  Write-Host "[apply] current package.json version: $($pkg.version)"
  if ($pkg.version -eq "1.0.6" -and ($Touched -contains "package.json")) {
    Write-Host "[apply] NOTE: version is already 1.0.6 — this patch may already be applied." -ForegroundColor Yellow
  }
} catch { }

# --- 2) split the patch into SRC (code) and DOCS (*.md) groups -------------
# Rationale: a stray keystroke in README.md/GUIDANCE.md must NOT block the code
# update. So we apply the two groups INDEPENDENTLY: code = hard requirement
# (mismatch aborts); docs = best-effort (mismatch is skipped with a warning).
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$rawPatch  = [System.IO.File]::ReadAllText($Patch)
$parts     = [regex]::Split($rawPatch, '(?m)(?=^diff --git )') | Where-Object { $_ -match '^diff --git ' }
$srcText = ""; $docsText = ""; $srcFiles = @(); $docsFiles = @()
foreach ($p in $parts) {
  $null = ($p -match 'diff --git a/(\S+) b/(\S+)')
  $bpath = $Matches[2]
  $winp  = ($bpath -replace '/', '\')
  if ($bpath.ToLower().EndsWith('.md')) { $docsText += $p; $docsFiles += $winp }
  else                                  { $srcText  += $p; $srcFiles  += $winp }
}
$srcPatch  = [System.IO.Path]::GetTempFileName()
$docsPatch = [System.IO.Path]::GetTempFileName()
if ($srcText)  { [System.IO.File]::WriteAllText($srcPatch,  $srcText,  $Utf8NoBom) }
if ($docsText) { [System.IO.File]::WriteAllText($docsPatch, $docsText, $Utf8NoBom) }

# status per group: "apply" | "applied" | "fail"
function Test-Group($patchFile, $hasContent) {
  if (-not $hasContent) { return "empty" }
  & git apply --check --whitespace=nowarn -- "$patchFile" 2>$null
  if ($LASTEXITCODE -eq 0) { return "apply" }
  & git apply -R --check --whitespace=nowarn -- "$patchFile" 2>$null
  if ($LASTEXITCODE -eq 0) { return "applied" }
  return "fail"
}

# --- 3) dry-run check each group ------------------------------------------
Write-Host "[apply] git apply --check (code + docs, separately) ..."
$srcStatus  = Test-Group $srcPatch  ([bool]$srcText)
$docsStatus = Test-Group $docsPatch ([bool]$docsText)

# Code group is a HARD requirement: mismatch aborts, nothing is modified.
if ($srcStatus -eq "fail") {
  Write-Host "[apply] CODE patch does not apply — git diagnostics:" -ForegroundColor Yellow
  & git apply --check --whitespace=nowarn -- "$srcPatch"
  Remove-Item -LiteralPath $srcPatch, $docsPatch -Force -ErrorAction SilentlyContinue
  Fail "CODE files differ from the patch base. This is the critical part, so nothing was modified. Commit/stash/restore the code file(s) and retry. (git restore package.json lib\http\http.js lib\util\mutex.js server.js lib\inference\TTS.py web\src\components\common\Fields.jsx)"
}

# Nothing to do at all?
if ($srcStatus -ne "apply" -and $docsStatus -ne "apply") {
  Write-Host "[apply] Everything is ALREADY APPLIED (code: $srcStatus, docs: $docsStatus) — nothing to do." -ForegroundColor Yellow
  Write-Host "[apply] To undo: rollback_patch.ps1 (or 回滚更新_rollback.bat)."
  Remove-Item -LiteralPath $srcPatch, $docsPatch -Force -ErrorAction SilentlyContinue
  exit 0
}
if ($srcStatus -eq "apply")   { Write-Host "[apply] CODE  check PASSED — will apply." -ForegroundColor Green }
else                          { Write-Host "[apply] CODE  already applied — will skip." -ForegroundColor Yellow }
if ($docsStatus -eq "apply")  { Write-Host "[apply] DOCS  check PASSED — will apply." -ForegroundColor Green }
elseif ($docsStatus -eq "applied") { Write-Host "[apply] DOCS  already applied — will skip." -ForegroundColor Yellow }
elseif ($docsStatus -eq "fail") {
  Write-Host "[apply] DOCS  do NOT match the patch base — will SKIP them (NON-blocking)." -ForegroundColor Yellow
  Write-Host "[apply]       (README.md / GUIDANCE.md were probably edited locally; the code update proceeds regardless." -ForegroundColor Yellow
  Write-Host "[apply]        Read the new sections manually in CHANGES-1.0.6.md if you want them.)"
}

# --- what's new (tell the user WHY they should update) ---------------------
Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " Aurivox 1.0.6  -  What's new / 更新内容" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " 1. Streaming responses / 流式传输"
Write-Host "    Send stream:true (or ?stream=1) to /v1/audio/speech to receive"
Write-Host "    audio as it is generated (wav/ogg). Default is no-persist"
Write-Host "    (nothing written to disk); set persist:true to also archive."
Write-Host "    Client disconnect aborts the running job."
Write-Host "    向 /v1/audio/speech 传 stream:true 边生成边返回(wav/ogg);"
Write-Host "    默认不落盘,persist:true 才归档;客户端断开即中止推理。"
Write-Host ""
Write-Host " 2. In-request parallel inference (A-1) / 请求内并行推理"
Write-Host "    A single long request is batched across sentences."
Write-Host "    Tune AURIVOX_TTS_BATCH_SIZE (default 4, range 1-16; set 1 on OOM)."
Write-Host "    单个长请求按句子并行合成,AURIVOX_TTS_BATCH_SIZE 调节(默认4,1-16,"
Write-Host "    显存不足设 1)。"
Write-Host ""
Write-Host " 3. Bounded overload queue (A-2) / 有界过载排队"
Write-Host "    Excess concurrent requests queue instead of thrashing; when the"
Write-Host "    queue is full the server returns 503 + Retry-After."
Write-Host "    AURIVOX_MAX_QUEUE (default 32, 0=unbounded), AURIVOX_RETRY_AFTER (3)."
Write-Host "    超并发的请求排队而非互相拖垮;队列满返回 503 + Retry-After。"
Write-Host ""
Write-Host " 4. Reference-audio residency / 参考音频留驻 (LRU)"
Write-Host "    Same model + different reference audio no longer reloads weights;"
Write-Host "    reference prompts are cached (LRU). AURIVOX_REF_CACHE (default 8)."
Write-Host "    Big win for recipe-style multi-voice distribution."
Write-Host "    同模型换参考音频不再重载权重,参考 prompt 走 LRU 缓存,"
Write-Host "    AURIVOX_REF_CACHE(默认8);多音色 recipe 分发提速明显。"
Write-Host ""
Write-Host " 5. Front-end 'Engine Batch (parallel)' toggle / 前端引擎批量并行开关"
Write-Host "    Generate & Compare Refs (Advanced Settings) can now hand the whole"
Write-Host "    text to the engine in ONE call for parallel batching (single audio,"
Write-Host "    no per-segment files). Compare Refs = master switch + per-row"
Write-Host "    3-state (inherit/on/off). Off by default (keeps segmented output)."
Write-Host "    Generate / Compare Refs 高级设置新增勾选框:整段一次性并行批量合成"
Write-Host "    (单音频,无分段文件);Compare 为总开关+每行三态(继承/开/关),默认关。"
Write-Host ""
Write-Host " 6. Front-end usage hints (EN/ZH) / 前端中英双语用法提示"
Write-Host "    The Broker API card documents streaming + the env vars above."
Write-Host "    Broker API 说明卡含流式与上述环境变量的用法说明。"
Write-Host ""
Write-Host " Details: CHANGES-1.0.6.md , BROKER_streaming_and_residency.md"
Write-Host "==================================================================" -ForegroundColor Cyan

# Build the list of files that will actually be applied now (for the plan + backup).
$applySrc  = ($srcStatus  -eq "apply")
$applyDocs = ($docsStatus -eq "apply")
$willApply = @()
if ($applySrc)  { $willApply += $srcFiles }
if ($applyDocs) { $willApply += $docsFiles }

# --- confirmation (stop and ask before touching anything) -----------------
if (-not $Yes) {
  Write-Host ""
  Write-Host "[apply] Plan (two independent git apply passes):" -ForegroundColor Cyan
  Write-Host ("          CODE ({0}): {1}" -f $srcFiles.Count, $(if ($applySrc) { "APPLY" } else { "skip ($srcStatus)" })) -ForegroundColor Cyan
  foreach ($f in $srcFiles)  { Write-Host "            $f" }
  Write-Host ("          DOCS ({0}): {1}" -f $docsFiles.Count, $(if ($applyDocs) { "APPLY" } elseif ($docsStatus -eq "fail") { "SKIP (local edits — non-blocking)" } else { "skip ($docsStatus)" })) -ForegroundColor Cyan
  foreach ($f in $docsFiles) { Write-Host "            $f" }
  $ans = Read-Host "[apply] Proceed? (Y/N)"
  if ($ans -notmatch '^(y|yes)$') {
    Write-Host "[apply] Cancelled — nothing was changed." -ForegroundColor Yellow
    Remove-Item -LiteralPath $srcPatch, $docsPatch -Force -ErrorAction SilentlyContinue
    exit 0
  }
}

# --- 4) backup (only the files we are about to change) --------------------
$ts  = Get-Date -Format "yyyyMMdd-HHmmss"
$bak = Join-Path $RepoRoot ".patch-backup\$ts"
New-Item -ItemType Directory -Force -Path $bak | Out-Null
foreach ($f in $willApply) {
  if (Test-Path $f) {
    $dest = Join-Path $bak $f
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -LiteralPath $f -Destination $dest -Force
  }
}
Copy-Item -LiteralPath $Patch -Destination (Join-Path $bak "applied.patch") -Force
try { (& git rev-parse HEAD) | Out-File -Encoding ascii (Join-Path $bak "HEAD.txt") } catch {}
Write-Host "[apply] backup -> $bak" -ForegroundColor Green

# --- 5) apply each group independently ------------------------------------
$applied = @()
if ($applySrc) {
  Write-Host "[apply] git apply (CODE) ..."
  & git apply --whitespace=nowarn -- "$srcPatch"
  if ($LASTEXITCODE -ne 0) {
    Remove-Item -LiteralPath $srcPatch, $docsPatch -Force -ErrorAction SilentlyContinue
    Fail "CODE apply failed AFTER passing --check (unexpected). Restore with rollback_patch.ps1 -From $bak"
  }
  $applied += $srcFiles
  Write-Host "[apply] CODE applied." -ForegroundColor Green
}
if ($applyDocs) {
  Write-Host "[apply] git apply (DOCS) ..."
  & git apply --whitespace=nowarn -- "$docsPatch"
  if ($LASTEXITCODE -ne 0) {
    # Docs are best-effort: a failure here does NOT undo the code update.
    Write-Host "[apply] WARNING: DOCS apply failed unexpectedly — SKIPPED. The code update above is fine." -ForegroundColor Yellow
  } else {
    $applied += $docsFiles
    Write-Host "[apply] DOCS applied." -ForegroundColor Green
  }
}
Remove-Item -LiteralPath $srcPatch, $docsPatch -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[apply] SUCCESS. Files changed:" -ForegroundColor Green
foreach ($f in $applied) { Write-Host "        $f" }
if ($docsStatus -eq "fail") {
  Write-Host "[apply] NOTE: README.md / GUIDANCE.md were SKIPPED (local edits). See CHANGES-1.0.6.md for the new doc sections." -ForegroundColor Yellow
}
Write-Host ""
if ($applySrc -and $TouchesFrontend) {
  Write-Host "[apply] FRONTEND CHANGED — you MUST rebuild the web bundle for the UI text to appear:" -ForegroundColor Yellow
  Write-Host "          run your frontend build (e.g. tools\build\01_build_frontend.* , or 'npm run build' in web\)"
  Write-Host "          then restart node server.js."
} elseif ($applySrc) {
  Write-Host "[apply] Rebuild is NOT required for the engine change (pure Python / Node)."
  Write-Host "[apply] Restart node server.js (and the infer_server) to pick up the changes."
}
Write-Host "[apply] Rollback if needed:  powershell -File rollback_patch.ps1 -Patch `"$Patch`"   (or -From `"$bak`")"
