# ============================================================
#  install_torch.ps1 — install PyTorch (CUDA) into the project venv
#  tools\deploy -> tools -> <root>
#
#  torch is intentionally NOT in requirements.txt (it is commented out there)
#  because its wheel is huge, CUDA-specific, and comes from a dedicated index.
#  This standalone script installs it separately and can be re-run any time
#  (e.g. to switch CUDA build, or after a failed / offline first attempt).
#
#  Usage (from anywhere):
#     powershell -ExecutionPolicy Bypass -File tools\deploy\install_torch.ps1
#     ... -Cuda cu118            # pick a different CUDA build (default cu121)
#     ... -Cpu                   # CPU-only build (no NVIDIA GPU)
#     ... -Torch 2.2.0 -Audio 2.2.0
#
#  Parameters (defaults): -Cuda cu121  -Torch 2.2.0  -Audio 2.2.0  -Vision 0.17.0
#                         -Cpu  installs the CPU-only build instead.
# ============================================================

# IMPORTANT: param() MUST be the very first statement in the script (only comments
# and blank lines may precede it). Do NOT put any executable line above it — e.g.
# an early [Console]::OutputEncoding=... here makes PowerShell stop treating this
# as a param block and fail to parse with "The assignment expression is not valid"
# on each [string]$X = '...'. The console-encoding line is set AFTER param() below.
param(
  [string]$Cuda   = 'cu121',
  [switch]$Cpu,
  [string]$Torch  = '2.2.0',
  [string]$Audio  = '2.2.0',
  [string]$Vision = '0.17.0',
  [switch]$WithDeps
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 'Continue' (not 'Stop'): uv/pip write progress to stderr, and under Windows
# PowerShell 5.1 native-command stderr + 'Stop' becomes a TERMINATING error that
# would abort mid-download with no log. Every native call is guarded by
# $LASTEXITCODE below, so 'Continue' is both safer and correct here.
$ErrorActionPreference = 'Continue'
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
$ROOT = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent

function Info($m){ Write-Host ('[torch] {0}' -f $m) -ForegroundColor Cyan }
function Ok($m){ Write-Host ('[torch] {0}' -f $m) -ForegroundColor Green }
function Warn($m){ Write-Host ('[torch] {0}' -f $m) -ForegroundColor Yellow }
function Die($m){ Write-Host ('[torch][ERROR] {0}' -f $m) -ForegroundColor Red; exit 1 }

# Run a native tool (uv/pip) with LIVE console output — progress bars and all.
# Start-Process -NoNewWindow -Wait lets the child inherit the console directly, so
# its output goes straight to the terminal and NOT through PowerShell's native-
# command/error pipeline (which used to crash the host). We only use the exit code
# to drive the automatic fall-back to a more compatible method.
function Invoke-Native {
  param([string]$Exe, [string[]]$CmdArgs)
  $argLine = ($CmdArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $p = Start-Process -FilePath $Exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}

# --- locate venv python (created by 首次部署.bat / bootstrap.ps1) ---
$VENV_PY = Join-Path $ROOT 'venv\Scripts\python.exe'
if (-not (Test-Path $VENV_PY)) {
  Die ("venv not found: {0}`n        Run 首次部署.bat first (it creates the venv), then re-run this." -f $VENV_PY)
}

if ($Cpu) {
  $index = 'https://download.pytorch.org/whl/cpu'
  Info ('installing CPU-only PyTorch: torch=={0} torchaudio=={1} torchvision=={2}' -f $Torch, $Audio, $Vision)
} else {
  $index = 'https://download.pytorch.org/whl/{0}' -f $Cuda
  Info ('installing PyTorch ({0}): torch=={1} torchaudio=={2} torchvision=={3}' -f $Cuda, $Torch, $Audio, $Vision)
}
Info ('index: {0}' -f $index)

$pkgs = @(("torch=={0}" -f $Torch), ("torchaudio=={0}" -f $Audio), ("torchvision=={0}" -f $Vision))

# CRITICAL: install torch WITHOUT its dependencies (--no-deps) by default.
# torch/torchaudio/torchvision declare deps like fsspec, sympy, networkx, jinja2,
# filelock, typing-extensions, numpy, pillow — all of which are ALREADY pinned in
# requirements.txt and installed in step 3. If we let pip/uv pull torch's deps, it
# re-resolves them against torch's ranges and happily UPGRADES/DOWNGRADES our
# locked versions (e.g. fsspec==2026.4.0 -> something else), silently breaking the
# frozen environment. Since deps are present, --no-deps installs torch cleanly and
# leaves every locked version untouched.
# Escape hatch: pass -WithDeps when installing torch onto a BARE venv (no prior
# `首次部署.bat` run), where torch's runtime deps aren't present yet.
$depFlag = @('--no-deps')
if ($WithDeps) {
  Warn '-WithDeps set — installing torch WITH its dependencies (may change locked versions).'
  $depFlag = @()
} else {
  Info 'installing torch with --no-deps (protects the locked requirements.txt versions).'
}

if (-not $env:UV_HTTP_TIMEOUT) { $env:UV_HTTP_TIMEOUT = '120' }
$env:UV_LINK_MODE = 'copy'

$UV_OK = $false
if ($env:TTS_NO_UV -eq '1') {
  Warn 'TTS_NO_UV=1 set — using pip for torch (uv skipped).'
} else {
  & $VENV_PY -m uv --version 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $UV_OK = $true }
}

if ($UV_OK) {
  # --index-strategy unsafe-best-match makes uv consider ALL indexes (like pip) so
  # it picks torch 2.2.0+cu121 from the CUDA index rather than the CPU build on PyPI.
  Info 'using uv for parallel torch download ...'
  $uvArgs = @('-m','uv','pip','install','--python', "$VENV_PY") + $depFlag + $pkgs + @('--extra-index-url', $index, '--index-strategy', 'unsafe-best-match')
  $rc = Invoke-Native $VENV_PY $uvArgs
  if ($rc -ne 0) { Warn 'uv torch install failed; falling back to pip (most compatible) ...'; $UV_OK = $false }
}
if (-not $UV_OK) {
  Info 'installing torch with pip ...'
  $pipArgs = @('-m','pip','install') + $depFlag + $pkgs + @('--extra-index-url', $index)
  $rc = Invoke-Native $VENV_PY $pipArgs
  if ($rc -ne 0) {
    Die 'torch install failed. Check your network / CUDA build, then re-run this script.'
  }
}

# --- verify ---
# NOTE: do NOT pass a multi-space / quoted string via `python -c $probe`. Under
# WinPS 5.1, native-argument re-parsing splits the string on spaces and strips the
# inner quotes, so python receives only `import torch; print(` -> SyntaxError.
# Writing a temp .py and running it is robust against that quoting mess.
$probe = @'
import torch
print("  torch", torch.__version__, "cuda_available =", torch.cuda.is_available())
'@
$probeTmp = Join-Path $env:TEMP ('ttsbroker_torchprobe_{0}.py' -f ([guid]::NewGuid().ToString('N')))
Set-Content -Path $probeTmp -Value $probe -Encoding UTF8
& $VENV_PY -u $probeTmp
$probeRC = $LASTEXITCODE
Remove-Item $probeTmp -ErrorAction SilentlyContinue
if ($probeRC -ne 0) {
  Warn 'torch installed but import/verify failed. See output above.'
  if (-not $WithDeps) {
    Warn 'If the error is a missing module (e.g. sympy/networkx/fsspec), you likely ran'
    Warn 'this on a bare venv. Run 首次部署.bat first, or re-run with -WithDeps.'
  }
} else { Ok 'PyTorch ready.' }
