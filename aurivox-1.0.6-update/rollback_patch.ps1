<#
  rollback_patch.ps1 — undo the Aurivox 1.0.6 patch.

  Two independent strategies (tries git reverse first, then filesystem backup):

  A) git reverse-apply (clean, preferred):
       powershell -ExecutionPolicy Bypass -File tools\rollback_patch.ps1
     Splits the patch into CODE and DOCS groups (same as apply) and reverses
     each group that still reverse-checks cleanly, skipping any that don't.
     This way a DOCS group that was never applied (skipped due to local edits)
     doesn't block reversing the CODE group.

  B) restore from the physical backup that apply_patch.ps1 made:
       powershell -ExecutionPolicy Bypass -File tools\rollback_patch.ps1 -From .patch-backup\<timestamp>
     Copies the saved files back verbatim. Works even if git is unavailable
     or the files were further edited.

  If -From is given, strategy B is used; otherwise A is attempted.
#>
[CmdletBinding()]
param(
  [string]$Patch = "aurivox-1.0.6.patch",
  [string]$From = "",
  [string]$RepoRoot = "."
)

$ErrorActionPreference = "Stop"
function Fail($msg) { Write-Host "[rollback] ERROR: $msg" -ForegroundColor Red; exit 1 }

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

$found = Find-RepoRoot $RepoRoot
if (-not $found) { $found = Find-RepoRoot (Get-Location).Path }
if (-not $found -and $PSScriptRoot) { $found = Find-RepoRoot $PSScriptRoot }
if (-not $found) { Fail "could not locate repo root (no package.json). Pass -RepoRoot <path>." }
$RepoRoot = $found
Set-Location $RepoRoot

if ($From) {
  # ---- Strategy B: restore every file saved in the backup folder ----
  $From = (Resolve-Path $From).Path
  Write-Host "[rollback] restoring from backup: $From"
  $skip = @("applied.patch","HEAD.txt")
  $n = 0
  Get-ChildItem -LiteralPath $From -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($From.Length).TrimStart('\','/')
    if ($skip -contains $rel) { return }
    New-Item -ItemType Directory -Force -Path (Split-Path $rel) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $rel -Force
    Write-Host "        restored $rel"
    $n++
  }
  if ($n -eq 0) { Fail "no restorable files found in $From" }
  Write-Host "[rollback] DONE ($n file(s) from backup). If a web\ file was restored, rebuild the frontend. Restart the server." -ForegroundColor Green
  exit 0
}

# ---- Strategy A: git reverse ----
if (-not (Test-Path $Patch)) {
  $alt = Join-Path $PSScriptRoot (Split-Path $Patch -Leaf)
  if (Test-Path $alt) { $Patch = $alt } else { Fail "patch not found: $Patch (or pass -From <backupDir>)" }
}
$Patch = (Resolve-Path $Patch).Path
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git not found; use -From <backupDir> instead." }

# Split the patch into CODE / DOCS groups (mirrors apply_patch.ps1) and reverse
# each group independently, so a never-applied DOCS group can't block the rest.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$rawPatch  = [System.IO.File]::ReadAllText($Patch)
$parts     = [regex]::Split($rawPatch, '(?m)(?=^diff --git )') | Where-Object { $_ -match '^diff --git ' }
$srcText = ""; $docsText = ""
foreach ($p in $parts) {
  $null = ($p -match 'diff --git a/(\S+) b/(\S+)')
  if ($Matches[2].ToLower().EndsWith('.md')) { $docsText += $p } else { $srcText += $p }
}

function Reverse-Group($name, $text) {
  if (-not $text) { return $false }
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, $text, $Utf8NoBom)
  & git apply -R --check --whitespace=nowarn -- "$tmp" 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[rollback] $name : reverse-check failed — SKIPPED (was not applied, or files changed)." -ForegroundColor Yellow
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    return $false
  }
  & git apply -R --whitespace=nowarn -- "$tmp"
  $ok = ($LASTEXITCODE -eq 0)
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  if ($ok) { Write-Host "[rollback] $name : reversed." -ForegroundColor Green }
  else     { Write-Host "[rollback] $name : reverse FAILED after check." -ForegroundColor Yellow }
  return $ok
}

Write-Host "[rollback] git reverse (CODE + DOCS, separately) ..."
$rc = Reverse-Group "CODE" $srcText
$rd = Reverse-Group "DOCS" $docsText
if (-not ($rc -or $rd)) { Fail "nothing could be reversed (files no longer match post-patch state). Use -From <backupDir>." }
Write-Host "[rollback] DONE (git reverse). If a web\ file was reverted, rebuild the frontend. Restart the server." -ForegroundColor Green
