[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
#  bootstrap.ps1 — TTS Broker first-time deployment
#  tools\deploy -> tools -> <root>
#  Steps:
#    1. locate embedded Python 3.11 (tools\runtime\python)
#    2. create venv\ at project root
#    3. install deps: local wheels (tools\wheels) + PyPI, EXCLUDING torch
#    4. install torch/torchaudio (CUDA 12.1)
#    5. self-check imports
#    6. guide model download (download_models.py)
# ============================================================

$ErrorActionPreference = 'Stop'
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
$ROOT = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent

$TORCH_VER      = 'torch==2.2.0'
$TORCHAUDIO_VER = 'torchaudio==2.2.0'
$TORCHVISION_VER = 'torchvision==0.17.0'
$CUDA_INDEX     = 'https://download.pytorch.org/whl/cu121'

function Info($m){ Write-Host ('[deploy] {0}' -f $m) -ForegroundColor Cyan }
function Ok($m){ Write-Host ('[deploy] {0}' -f $m) -ForegroundColor Green }
function Warn($m){ Write-Host ('[deploy] {0}' -f $m) -ForegroundColor Yellow }
function Die($m){ Write-Host ('[deploy][ERROR] {0}' -f $m) -ForegroundColor Red; exit 1 }

Info ('project root : {0}' -f $ROOT)

# --- 1. embedded python ---
$EMB_PY = Join-Path $ROOT 'tools\runtime\python\python.exe'
if (-not (Test-Path $EMB_PY)) {
  Warn ('embedded python not found: {0}' -f $EMB_PY)
  Warn 'Falling back to a system python on PATH (must be 3.11.x).'
  $sys = (Get-Command python -ErrorAction SilentlyContinue)
  if (-not $sys) { Die 'No embedded python and no system python. Run tools\build\03_fetch_runtimes.py, or install Python 3.11.' }
  $EMB_PY = $sys.Source
}
$pyver = (& $EMB_PY --version) 2>&1
Info ('using python: {0} ({1})' -f $EMB_PY, $pyver)
if ($pyver -notmatch '3\.11\.') { Warn ('expected Python 3.11.x, got: {0} — continuing but this may break compiled wheels.' -f $pyver) }

# --- 2. create venv ---
$VENV = Join-Path $ROOT 'venv'
$VENV_PY = Join-Path $VENV 'Scripts\python.exe'
if (Test-Path $VENV_PY) {
  Ok ('venv already exists: {0}' -f $VENV)
} else {
  Info 'creating venv ...'
  & $EMB_PY -m venv "$VENV"
  if (-not (Test-Path $VENV_PY)) { Die 'venv creation failed.' }
  Ok 'venv created.'
}

# --- upgrade pip ---
Info 'upgrading pip / setuptools / wheel ...'
& $VENV_PY -m pip install --upgrade "pip" "setuptools<81" "wheel"

# --- 3. project deps (exclude torch; torch is commented out in requirements.txt) ---
$REQ    = Join-Path $ROOT 'requirements.txt'
$WHEELS = Join-Path $ROOT 'tools\wheels'
if (-not (Test-Path $REQ)) { Die ('requirements.txt not found: {0}' -f $REQ) }

$findLinks = @()
if (Test-Path $WHEELS) {
  $whlCount = (Get-ChildItem $WHEELS -Filter *.whl -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($whlCount -gt 0) {
    Info ('found {0} local wheel(s) in tools\wheels — will prefer them.' -f $whlCount)
    $findLinks = @('--find-links', "$WHEELS")
  } else {
    Warn 'tools\wheels is empty — jieba_fast / pyopenjtalk will be built from source (needs a C/C++ compiler).'
  }
} else {
  Warn 'tools\wheels missing — compile-needing packages may fail without a compiler.'
}

Info 'installing project dependencies (this may take a while) ...'
$pipArgs = @('-m','pip','install') + $findLinks + @('-r', "$REQ")
& $VENV_PY @pipArgs
if ($LASTEXITCODE -ne 0) { Die 'dependency install failed. See output above.' }
Ok 'project dependencies installed.'

# --- 4. torch (CUDA 12.1) — delegated to the standalone install_torch.ps1 ---
# torch is kept out of requirements.txt (huge, CUDA-specific, dedicated index),
# so it is installed by its own re-runnable script. This keeps concerns separate
# and lets users re-install / switch CUDA build without re-running the whole
# bootstrap: tools\deploy\install_torch.ps1  (or 安装PyTorch.bat).
$torchScript = Join-Path $SCRIPT_DIR 'install_torch.ps1'
if (Test-Path $torchScript) {
  Info 'installing PyTorch via install_torch.ps1 ...'
  & powershell -ExecutionPolicy Bypass -NoProfile -File $torchScript
  if ($LASTEXITCODE -ne 0) { Warn 'torch install failed. Re-run tools\deploy\install_torch.ps1 (or 安装PyTorch.bat) later.' }
  else { Ok 'PyTorch installed.' }
} else {
  Warn ('install_torch.ps1 not found next to bootstrap: {0}' -f $torchScript)
  Warn 'Falling back to inline torch install.'
  & $VENV_PY -m pip install $TORCH_VER $TORCHAUDIO_VER $TORCHVISION_VER --extra-index-url $CUDA_INDEX
  if ($LASTEXITCODE -ne 0) { Warn 'torch install failed. Check your network / CUDA. You can re-run this script.' }
  else { Ok 'PyTorch installed.' }
}

New-Item -ItemType Directory -Force -Path (Join-Path $ROOT 'logs') | Out-Null

# --- 5. self-check ---
Info 'self-check: importing core packages ...'
$check = @'
import importlib, sys
mods = ["torch","torchaudio","numpy","librosa","soundfile","transformers",
        "jieba_fast","pyopenjtalk","ctranslate2","faster_whisper","fastapi","onnxruntime"]
bad = []
for m in mods:
    try:
        importlib.import_module(m)
    except Exception as e:
        bad.append((m, repr(e)[:120]))
try:
    import torch
    print("  torch", torch.__version__, "cuda_available=", torch.cuda.is_available())
except Exception as e:
    print("  torch import failed:", e)
if bad:
    print("  MISSING/BROKEN:")
    for m, e in bad: print("    -", m, "=>", e)
    sys.exit(3)
print("  all core imports OK")
'@
$tmp = Join-Path $env:TEMP ('ttsbroker_check_{0}.py' -f ([guid]::NewGuid().ToString('N')))
Set-Content -Path $tmp -Value $check -Encoding UTF8
& $VENV_PY $tmp
$checkRC = $LASTEXITCODE
Remove-Item $tmp -ErrorAction SilentlyContinue
if ($checkRC -ne 0) { Warn 'some imports failed (see above). torch/CUDA or a compiled wheel may be missing.' }
else { Ok 'import self-check passed.' }

# --- 6. models ---
Write-Host ''
Info '========================================================'
Info ' Dependencies done. Models are NOT bundled (~9GB).'
Info ' Launch the model download wizard now? It downloads to'
Info '   lib\training\gsv-tools\pretrained | asr | uvr5_weights'
Info '========================================================'
$ans = Read-Host 'Download models now? [Y/n]'
if ($ans -notmatch '^[Nn]') {
  $dl = Join-Path $SCRIPT_DIR 'download_models.py'
  if (Test-Path $dl) {
    & $VENV_PY $dl --wizard
  } else {
    Warn ('download_models.py not found: {0}' -f $dl)
  }
} else {
  Info 'Skipped. Run  venv\Scripts\python.exe tools\deploy\download_models.py --wizard  later.'
}

Write-Host ''
Ok 'Bootstrap finished. You can now run 启动.bat'
exit 0
