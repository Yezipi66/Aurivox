#requires -Version 5.1
# ============================================================
#  try_indextts2.ps1  (ASCII-only to avoid WinPS 5.1 GBK mojibake)
#  Force-install IndexTTS2 into the EXISTING torch 2.2 venv WITHOUT
#  upgrading torch, then test whether IndexTTS2 can import/run on 2.2.
#
#  Safe: never installs/upgrades torch or torchaudio. Verifies torch
#  stayed 2.2 after install and aborts if something replaced it.
#  You already have venv_bak as a backup.
#
#  Usage (from D:\Project\tts_broker_openai_compat):
#    powershell -ExecutionPolicy Bypass -File try_indextts2.ps1 -IndexRepo D:\AI\index-tts
# ============================================================
param(
  [string]$IndexRepo   = 'D:\AI\index-tts',
  [string]$ProjectRoot = 'D:\Project\tts_broker_openai_compat',
  [switch]$WithSmoke
)

$ErrorActionPreference = 'Continue'

function Info($m){ Write-Host ('[try] ' + $m) -ForegroundColor Cyan }
function Ok($m){   Write-Host ('[try] ' + $m) -ForegroundColor Green }
function Warn($m){ Write-Host ('[try] ' + $m) -ForegroundColor Yellow }
function Die($m){  Write-Host ('[try][STOP] ' + $m) -ForegroundColor Red; exit 1 }

$PY = Join-Path $ProjectRoot 'venv\Scripts\python.exe'
if (-not (Test-Path $PY)) { Die ('venv python not found: ' + $PY) }
if (-not (Test-Path (Join-Path $ProjectRoot 'venv_bak'))) {
  Warn 'venv_bak backup not found. Strongly recommend backing up venv first.'
  $ans = Read-Host 'Continue anyway? (yes/no)'
  if ($ans -ne 'yes') { Die 'Aborted by user. Back up venv first.' }
}
if (-not (Test-Path (Join-Path $IndexRepo 'pyproject.toml'))) {
  Die ('No pyproject.toml under ' + $IndexRepo + ' -- not the index-tts repo root. Fix -IndexRepo.')
}

function Get-TorchVer {
  & $PY -c "import torch,torchaudio;print(torch.__version__+'|'+torchaudio.__version__)" 2>$null
}
$before = Get-TorchVer
Info ('current torch|torchaudio = ' + $before)
if (-not $before) { Warn 'torch/torchaudio not importable in current venv? Check SoVITS env first.' }

# --- 1. install IndexTTS2 NON-torch deps (torch/torchaudio deliberately excluded) ---
$deps = @(
  'accelerate==1.8.1','cn2an==0.5.22','descript-audiotools==0.7.2','einops>=0.8.1',
  'ffmpeg-python==0.2.0','g2p-en==2.1.0','jieba==0.42.1','json5==0.10.0',
  'librosa==0.10.2.post1','munch==4.0.0','numba==0.58.1','numpy==1.26.2',
  'omegaconf>=2.3.0','safetensors','sentencepiece>=0.2.1','tokenizers==0.21.0',
  'transformers==4.52.1','tqdm>=4.67.1','wetext>=0.0.9','modelscope==1.27.0'
)
Info 'installing IndexTTS2 non-torch deps (torch stays 2.2) ...'
Warn 'NOTE: transformers will move to 4.52.1, replacing SoVITS <=4.50. That is what venv_bak is for.'
& $PY -m pip install @deps
if ($LASTEXITCODE -ne 0) { Warn 'pip deps returned non-zero; continuing, but check errors above.' }

# --- 2. install indextts itself, NEVER pulling torch ---
Info 'pip install -e <repo> --no-deps (package only, no torch 2.8) ...'
& $PY -m pip install -e "$IndexRepo" --no-deps
if ($LASTEXITCODE -ne 0) { Warn 'indextts editable install non-zero; see errors above.' }

# --- 3. verify torch was not replaced ---
$after = Get-TorchVer
Info ('after install torch|torchaudio = ' + $after)
if ($after -ne $before) {
  Die ('torch CHANGED! before=' + $before + ' after=' + $after + ' -- something upgraded torch. Restore venv_bak and tell me; I will adjust the exclude list.')
}
Ok 'torch is still 2.2, not replaced.'

# --- 4. STAGE 1 signal: can we import IndexTTS2 (no checkpoints needed) ---
Info 'importing IndexTTS2 inference module (surfaces torch API/ABI breakage) ...'
$probe = @'
import sys, traceback
try:
    import torch, torchaudio
    print("  torch", torch.__version__, "torchaudio", torchaudio.__version__, "cuda", torch.cuda.is_available())
    import indextts
    print("  indextts package OK:", getattr(indextts, "__file__", "?"))
    from indextts.infer_v2 import IndexTTS2
    print("  import IndexTTS2 class OK")
    print("RESULT: IMPORT_PASS")
except Exception:
    traceback.print_exc()
    print("RESULT: IMPORT_FAIL")
    sys.exit(3)
'@
$tmp = Join-Path $env:TEMP ('idx2_import_' + [guid]::NewGuid().ToString('N') + '.py')
Set-Content -Path $tmp -Value $probe -Encoding UTF8
& $PY -u $tmp
$rc = $LASTEXITCODE
Remove-Item $tmp -ErrorAction SilentlyContinue

Write-Host ''
if ($rc -eq 0) {
  Ok  'STAGE 1 PASS: IndexTTS2 imports on torch 2.2.'
  Info 'So the 2.8 pin is at least a conservative guard (not a hard floor) for loading.'
  if ($WithSmoke) {
    Info 'STAGE 2 (manual): download checkpoints per index-tts README into <repo>\checkpoints,'
    Info '  then synthesize one line via its CLI to test real inference / speed / VRAM.'
  } else {
    Info 'To actually synthesize: download checkpoints, then use the official CLI.'
  }
} else {
  Warn 'STAGE 1 FAIL: it broke at import (see traceback above).'
  Warn 'Paste the full traceback back to me. I classify by error type:'
  Warn '  * AttributeError / requires torch>=... => a few APIs, small refactor may fix'
  Warn '  * undefined symbol / ABI => compiled ext incompatible with torch 2.2, drop unify'
}

Write-Host ''
Info 'Done. To restore a clean SoVITS env: replace venv with venv_bak.'
