<#
.SYNOPSIS
  Migrate GPT-SoVITS base models to the one-directory-per-version layout.

.DESCRIPTION
  Old layout (weights of a single version split across two directories whose
  names do not say which version they hold):

    models/tts/gpt-sovits/gsv-v2final/  s1bert25hz-2kh-*.ckpt   (v1  GPT)
                                        s1bert25hz-5kh-*.ckpt   (v2  GPT)
                                        s2G2333k.pth s2D2333k.pth (v2 SoVITS)
    models/tts/gpt-sovits/v2Pro/        s2G488k.pth  s2D488k.pth  (v1 SoVITS!)
                                        s2Gv2Pro.pth s2Dv2Pro.pth
                                        s2Gv2ProPlus.pth s2Dv2ProPlus.pth

  New layout:

    models/tts/gpt-sovits/v1/         s1bert25hz-2kh-*.ckpt  s2G488k.pth  s2D488k.pth
                          v2/         s1bert25hz-5kh-*.ckpt  s2G2333k.pth s2D2333k.pth
                          v2Pro/      s2Gv2Pro.pth      s2Dv2Pro.pth
                          v2ProPlus/  s2Gv2ProPlus.pth  s2Dv2ProPlus.pth

  The GPT (s1) half only exists in two flavours upstream. v2, v2Pro and
  v2ProPlus all load the same one, which is why it lives in v2/ and the two Pro
  directories hold SoVITS weights only.

  The script also rewrites lib/inference/tts_infer.yaml, which is per-machine
  and not in git: the engine regenerates it on model hot-swap, so a migration
  that only moves files would leave inference pointing at the old paths.

  Safe to run twice: the second run reports "already migrated" and changes
  nothing. Runs as a dry run by default.

.PARAMETER Apply
  Actually move the files. Without it the script only reports what it would do.

.PARAMETER ProjectRoot
  Project root. Defaults to two levels above this script (tools/scripts/ -> root).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\scripts\Move-BaseModels.ps1
  powershell -ExecutionPolicy Bypass -File tools\scripts\Move-BaseModels.ps1 -Apply
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectRoot) {
  $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
if (-not (Test-Path (Join-Path $ProjectRoot 'server.js'))) {
  throw "Not a project root (no server.js): $ProjectRoot"
}

$Pre = Join-Path $ProjectRoot 'models\tts\gpt-sovits'
if (-not (Test-Path $Pre)) {
  throw "Base model directory not found: $Pre"
}

$S1v1 = 's1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt'
$S1v2 = 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'

# from-subdir, filename, to-subdir
$Moves = @(
  @{ From = 'gsv-v2final'; File = $S1v1;             To = 'v1' },
  @{ From = 'v2Pro';       File = 's2G488k.pth';     To = 'v1' },
  @{ From = 'v2Pro';       File = 's2D488k.pth';     To = 'v1' },
  @{ From = 'gsv-v2final'; File = $S1v2;             To = 'v2' },
  @{ From = 'gsv-v2final'; File = 's2G2333k.pth';    To = 'v2' },
  @{ From = 'gsv-v2final'; File = 's2D2333k.pth';    To = 'v2' },
  @{ From = 'v2Pro'; File = 's2Gv2ProPlus.pth'; To = 'v2ProPlus' },
  @{ From = 'v2Pro'; File = 's2Dv2ProPlus.pth'; To = 'v2ProPlus' }
)
# s2Gv2Pro.pth / s2Dv2Pro.pth stay where they are: v2Pro/ is already correct.

$mode = if ($Apply) { 'APPLY' } else { 'DRY RUN (add -Apply to move files)' }
Write-Host "Base model migration - $mode"
Write-Host "Root: $ProjectRoot"
Write-Host ''

$planned = 0
$missing = 0
$already = 0
$conflict = 0

foreach ($m in $Moves) {
  $src = Join-Path (Join-Path $Pre $m.From) $m.File
  $dstDir = Join-Path $Pre $m.To
  $dst = Join-Path $dstDir $m.File
  $label = "$($m.From)\$($m.File)  ->  $($m.To)\$($m.File)"

  if (Test-Path $dst) {
    if (Test-Path $src) {
      # Both copies present: do not guess which is authoritative.
      Write-Host "  CONFLICT  $label  (both source and destination exist; resolve by hand)"
      $conflict++
    } else {
      Write-Host "  already   $($m.To)\$($m.File)"
      $already++
    }
    continue
  }
  if (-not (Test-Path $src)) {
    Write-Host "  missing   $($m.From)\$($m.File)  (not downloaded on this machine)"
    $missing++
    continue
  }

  Write-Host "  move      $label"
  $planned++
  if ($Apply) {
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    Move-Item -LiteralPath $src -Destination $dst
  }
}

# Retire the old directory once it is empty. v2Pro/ is kept: it is part of the
# new layout too.
$oldDir = Join-Path $Pre 'gsv-v2final'
if (Test-Path $oldDir) {
  $left = @(Get-ChildItem -LiteralPath $oldDir -Force)
  if ($left.Count -eq 0) {
    Write-Host "  remove    gsv-v2final\ (now empty)"
    if ($Apply) { Remove-Item -LiteralPath $oldDir -Force }
  } else {
    Write-Host "  keep      gsv-v2final\ still holds $($left.Count) item(s); not removed"
  }
}

# ---- live tts_infer.yaml ---------------------------------------------------
# Not in git, rewritten by the engine on hot-swap. Only the weight paths are
# touched; every other line is left byte-for-byte alone.
$yaml = Join-Path $ProjectRoot 'lib\inference\tts_infer.yaml'
if (Test-Path $yaml) {
  $text = Get-Content -LiteralPath $yaml -Raw -Encoding UTF8
  $orig = $text
  $subs = @(
    @("gpt-sovits/gsv-v2final/$S1v1", "gpt-sovits/v1/$S1v1"),
    @("gpt-sovits/gsv-v2final/$S1v2", "gpt-sovits/v2/$S1v2"),
    @('gpt-sovits/v2Pro/s2G488k.pth',      'gpt-sovits/v1/s2G488k.pth'),
    @('gpt-sovits/v2Pro/s2D488k.pth',      'gpt-sovits/v1/s2D488k.pth'),
    @('gpt-sovits/gsv-v2final/s2G2333k.pth', 'gpt-sovits/v2/s2G2333k.pth'),
    @('gpt-sovits/gsv-v2final/s2D2333k.pth', 'gpt-sovits/v2/s2D2333k.pth'),
    @('gpt-sovits/v2Pro/s2Gv2ProPlus.pth', 'gpt-sovits/v2ProPlus/s2Gv2ProPlus.pth'),
    @('gpt-sovits/v2Pro/s2Dv2ProPlus.pth', 'gpt-sovits/v2ProPlus/s2Dv2ProPlus.pth')
  )
  foreach ($s in $subs) { $text = $text.Replace($s[0], $s[1]) }
  if ($text -ne $orig) {
    Write-Host ''
    Write-Host "  rewrite   lib\inference\tts_infer.yaml (weight paths)"
    if ($Apply) {
      Copy-Item -LiteralPath $yaml -Destination "$yaml.bak" -Force
      [System.IO.File]::WriteAllText($yaml, $text, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "            backup written to tts_infer.yaml.bak"
    }
  } else {
    Write-Host ''
    Write-Host "  ok        lib\inference\tts_infer.yaml already on the new layout"
  }
} else {
  Write-Host ''
  Write-Host "  note      lib\inference\tts_infer.yaml not present; it is generated on first use"
}

Write-Host ''
Write-Host "Summary: move=$planned  already=$already  missing=$missing  conflict=$conflict"
if ($conflict -gt 0) {
  Write-Host 'Conflicts found. Nothing was decided for those files; delete the stale copy yourself, then re-run.'
  exit 2
}
if (-not $Apply -and $planned -gt 0) {
  Write-Host 'Dry run. Re-run with -Apply to perform the moves.'
}
exit 0
