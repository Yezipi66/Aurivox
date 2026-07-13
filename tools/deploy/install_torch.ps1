[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

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
# ============================================================

param(
  [string]$Cuda   = 'cu121',     # cu121 / cu118 / cu124 ...
  [switch]$Cpu,                  # install CPU-only build instead
  [string]$Torch  = '2.2.0',
  [string]$Audio  = '2.2.0',
  [string]$Vision = '0.17.0'
)

$ErrorActionPreference = 'Stop'
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
$ROOT = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent

function Info($m){ Write-Host ('[torch] {0}' -f $m) -ForegroundColor Cyan }
function Ok($m){ Write-Host ('[torch] {0}' -f $m) -ForegroundColor Green }
function Warn($m){ Write-Host ('[torch] {0}' -f $m) -ForegroundColor Yellow }
function Die($m){ Write-Host ('[torch][ERROR] {0}' -f $m) -ForegroundColor Red; exit 1 }

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

& $VENV_PY -m pip install ("torch=={0}" -f $Torch) ("torchaudio=={0}" -f $Audio) ("torchvision=={0}" -f $Vision) --extra-index-url $index
if ($LASTEXITCODE -ne 0) {
  Die 'torch install failed. Check your network / CUDA build, then re-run this script.'
}

# --- verify ---
$probe = 'import torch; print("  torch", torch.__version__, "cuda_available =", torch.cuda.is_available())'
& $VENV_PY -c $probe
if ($LASTEXITCODE -ne 0) { Warn 'torch installed but import/verify failed. See output above.' }
else { Ok 'PyTorch ready.' }
