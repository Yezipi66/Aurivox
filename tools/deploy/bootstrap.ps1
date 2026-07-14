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

# NOTE: use 'Continue', NOT 'Stop'. Under Windows PowerShell 5.1, a *native*
# command (uv/pip) that writes to stderr while $ErrorActionPreference='Stop' is
# turned into a TERMINATING error — which aborts this script mid-install (before
# our $LASTEXITCODE fallbacks can run) and, with no transcript, leaves no log:
# the classic "uv 解析到四十多个包就闪退, 没有日志". uv prints its progress to
# stderr, so 'Stop' would kill us there. We guard every native call explicitly
# with $LASTEXITCODE below, and wrap the whole run in try/catch + a transcript,
# so nothing disappears silently anymore.
$ErrorActionPreference = 'Continue'
$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
$ROOT = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent

# --- 0a. GUARD: refuse a non-ASCII (e.g. Chinese) install path ------------
# A path containing non-ASCII characters (e.g. D:\<chinese>\) is destroyed to
# D:\??\ the moment a child process (python/ffmpeg/uv) is launched through the
# Windows GBK/ANSI console codepage, so those tools can no longer be found
# ("No Python at 'D:\??\...\python.exe'", slice/ASR/train all fail). We must
# validate $ROOT here -- it is the REAL Unicode path from $PSScriptRoot; a path
# read back from the console is already mangled to '?' (0x3F, ASCII) and would
# falsely pass. Message kept ASCII-only so it renders in any console/encoding;
# the Chinese explanation is printed by the .bat wrapper on exit code 7.
$__badChars = @()
foreach ($c in $ROOT.ToCharArray()) { if ([int][char]$c -gt 127) { $__badChars += $c } }
if ($__badChars.Count -gt 0) {
  Write-Host ''
  Write-Host '============================================================' -ForegroundColor Red
  Write-Host '[deploy][FATAL] Install path contains non-ASCII characters.' -ForegroundColor Red
  Write-Host ('  path : {0}' -f $ROOT) -ForegroundColor Red
  Write-Host ('  bad  : {0}' -f ($__badChars -join ' ')) -ForegroundColor Red
  Write-Host '  A non-English path (Chinese etc.) breaks Python/ffmpeg' -ForegroundColor Red
  Write-Host '  process launching on Windows. Move the WHOLE folder to a' -ForegroundColor Red
  Write-Host '  pure-English path such as  D:\TTS-Broker  then re-run.' -ForegroundColor Red
  Write-Host '============================================================' -ForegroundColor Red
  exit 7
}

$TORCH_VER      = 'torch==2.2.0'
$TORCHAUDIO_VER = 'torchaudio==2.2.0'
$TORCHVISION_VER = 'torchvision==0.17.0'
$CUDA_INDEX     = 'https://download.pytorch.org/whl/cu121'

function Info($m){ Write-Host ('[deploy] {0}' -f $m) -ForegroundColor Cyan }
function Ok($m){ Write-Host ('[deploy] {0}' -f $m) -ForegroundColor Green }
function Warn($m){ Write-Host ('[deploy] {0}' -f $m) -ForegroundColor Yellow }
function Die($m){ Write-Host ('[deploy][ERROR] {0}' -f $m) -ForegroundColor Red; exit 1 }

# Run a native tool (uv/pip) with LIVE output — progress bars and all — shown on
# the real console. We use Start-Process -NoNewWindow -Wait so the child inherits
# the console directly: its stdout/stderr go straight to the terminal (WT/conhost
# render ANSI natively) and DO NOT flow through PowerShell's native-command /
# error-record pipeline, which is what used to crash the host. This keeps the full,
# normal installer experience for everyone; we only rely on the exit code to drive
# the automatic fall-back to a more compatible method when a step fails.
function Invoke-Native {
  param([string]$Exe, [string[]]$CmdArgs)
  $argLine = ($CmdArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $p = Start-Process -FilePath $Exe -ArgumentList $argLine -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}

# --- 0. logging: always capture a transcript so a crash is never silent ---
$LOG_DIR = Join-Path $ROOT 'logs'
$LOG_FILE = $null
try {
  New-Item -ItemType Directory -Force -Path $LOG_DIR -ErrorAction SilentlyContinue | Out-Null
  $LOG_FILE = Join-Path $LOG_DIR ('deploy_{0}.log' -f (Get-Date -Format 'yyyyMMdd_HHmmss'))
  Start-Transcript -Path $LOG_FILE -Append -ErrorAction SilentlyContinue | Out-Null
  Write-Host ('[deploy] logging to: {0}' -f $LOG_FILE) -ForegroundColor DarkCyan
} catch {
  Write-Host '[deploy] (could not start transcript — continuing without a log file)' -ForegroundColor Yellow
}

try {

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
# A venv is NOT relocatable: pyvenv.cfg bakes the ABSOLUTE path of the base
# interpreter used to create it. If the project folder was moved/renamed (or was
# first deployed under a non-English path), the existing venv's python is a
# trampoline still pointing at the OLD base path and every call dies with
# "No Python at '...\python.exe'". So we don't blindly trust an existing venv:
# we health-check it, and if it is broken we rebuild it against the CURRENT
# embedded runtime. This is what lets the whole project be moved freely.
$venvOk = $false
if (Test-Path $VENV_PY) {
  & $VENV_PY -c "import sys" 2>$null
  if ($LASTEXITCODE -eq 0) { $venvOk = $true }
}
if ($venvOk) {
  Ok ('venv already exists and works: {0}' -f $VENV)
} else {
  if (Test-Path $VENV) {
    Warn ('existing venv is broken or was moved from another path; rebuilding it: {0}' -f $VENV)
    Remove-Item -Recurse -Force $VENV -ErrorAction SilentlyContinue
  }
  Info 'creating venv ...'
  & $EMB_PY -m venv "$VENV"
  if (-not (Test-Path $VENV_PY)) { Die 'venv creation failed.' }
  # sanity: the freshly created venv must actually run
  & $VENV_PY -c "import sys" 2>$null
  if ($LASTEXITCODE -ne 0) { Die 'venv was created but its python cannot run. Check the embedded runtime.' }
  Ok 'venv created.'
}

# --- upgrade pip ---
Info 'upgrading pip / setuptools / wheel ...'
$null = Invoke-Native $VENV_PY @('-m','pip','install','--upgrade','pip','setuptools<81','wheel')

# --- ensure uv (fast, parallel installer) ---
# uv downloads/installs wheels in parallel with a global cache — typically 5-10x
# faster than pip for a large freeze. It is a single small no-dep wheel to fetch;
# if it can't be installed we transparently fall back to pip below.
# Give uv a generous network timeout. We deliberately DO NOT disable uv's progress
# bar or cap its parallelism: progress is shown live on the console (via
# Invoke-Native / Start-Process, which keeps it off the crash-prone PS pipeline),
# and we let uv run at its normal speed. If a machine's antivirus/EDR still trips
# it up, we don't cripple everyone — we simply fall back to pip automatically on
# failure (see below), which is the most compatible path.
if (-not $env:UV_HTTP_TIMEOUT) { $env:UV_HTTP_TIMEOUT = '120' }
# The uv global cache (C:) and the venv (often on D:) are usually on DIFFERENT
# drives, so uv can't hardlink and prints a warning while it probes+falls back to
# a full copy. Tell it to copy up front: no warning, deterministic.
$env:UV_LINK_MODE   = 'copy'

$UV_OK = $false
# Escape hatch: set TTS_NO_UV=1 to skip uv entirely and install with pip. Use this
# if uv appears to die/vanish mid-install on a specific machine (some antivirus /
# EDR products kill the freshly-downloaded uv.exe or its child process tree while
# it writes into site-packages). pip is pure-python and far less likely to trip
# that. Slower, but rock-solid.  cmd:  set TTS_NO_UV=1  &  首次部署.bat
if ($env:TTS_NO_UV -eq '1') {
  Warn 'TTS_NO_UV=1 set — skipping uv, installing with pip only.'
} else {
  Info 'installing uv (parallel package installer) ...'
  $uvInstRC = Invoke-Native $VENV_PY @('-m','pip','install','--upgrade','uv')
  if ($uvInstRC -eq 0) {
    & $VENV_PY -m uv --version 2>$null
    if ($LASTEXITCODE -eq 0) { $UV_OK = $true; Ok 'uv ready — will use it for parallel installs.' }
  }
  if (-not $UV_OK) { Warn 'uv unavailable — falling back to pip (slower).' }
}

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
# requirements.txt is a COMPLETE `pip freeze` snapshot (every transitive dep is
# pinned). Install it with --no-deps so pip installs each pinned version as-is
# WITHOUT running its dependency resolver. This is the correct way to reproduce
# a frozen environment, and it avoids "ResolutionImpossible" from pins that are
# individually fine but conflict on paper (e.g. a newer fsspec vs an older
# datasets upper-bound) yet work at runtime on the machine they were frozen on.
if ($UV_OK) {
  # uv pip install: parallel downloads + global cache, with its normal live
  # progress bar shown on the console. --python targets the venv; --no-deps mirrors
  # the pip path (install the frozen pins as-is, no resolver). On ANY failure we
  # fall back to pip below — the most compatible path.
  Info 'installing with uv (parallel) ...'
  $uvArgs = @('-m','uv','pip','install','--python', "$VENV_PY", '--no-deps',
              '--index-strategy','unsafe-best-match') + $findLinks + @('-r', "$REQ")
  $uvRC = Invoke-Native $VENV_PY $uvArgs
  if ($uvRC -ne 0) {
    Warn 'uv install failed; falling back to pip --no-deps (most compatible) ...'
    $UV_OK = $false
  }
}
if (-not $UV_OK) {
  Info 'installing with pip --no-deps ...'
  $pipArgs = @('-m','pip','install','--no-deps') + $findLinks + @('-r', "$REQ")
  $pRC = Invoke-Native $VENV_PY $pipArgs
  if ($pRC -ne 0) {
    Warn 'no-deps install failed; retrying WITH the resolver (may hit version conflicts)...'
    $pipArgs2 = @('-m','pip','install') + $findLinks + @('-r', "$REQ")
    $pRC2 = Invoke-Native $VENV_PY $pipArgs2
    if ($pRC2 -ne 0) { Die 'dependency install failed. See the output above.' }
  }
}
Ok 'project dependencies installed.'

# --no-deps trusts the freeze to be complete. Do a light sanity pass so a missing
# pin surfaces here (with a clear hint) instead of as a cryptic import error later.
Info 'verifying dependency tree (pip check) ...'
& $VENV_PY -m pip check
if ($LASTEXITCODE -ne 0) {
  Warn 'pip check reported issues above. If they are only "has requirement X, but'
  Warn 'you have Y" warnings for packages that still import fine (common with a'
  Warn 'frozen env), you can ignore them. If a package is MISSING, add it to'
  Warn 'requirements.txt and re-run 首次部署.bat.'
}

# --- 4. torch (CUDA 12.1) — delegated to the standalone install_torch.ps1 ---
# torch is kept out of requirements.txt (huge, CUDA-specific, dedicated index),
# so it is installed by its own re-runnable script. This keeps concerns separate
# and lets users re-install / switch CUDA build without re-running the whole
# bootstrap: tools\deploy\install_torch.ps1  (or 安装PyTorch.bat).
$TORCH_OK = $false
$torchScript = Join-Path $SCRIPT_DIR 'install_torch.ps1'
if (Test-Path $torchScript) {
  Info 'installing PyTorch via install_torch.ps1 ...'
  & powershell -ExecutionPolicy Bypass -NoProfile -File $torchScript
  if ($LASTEXITCODE -ne 0) { Warn 'torch install reported a non-zero exit — will verify by import below.' }
} else {
  Warn ('install_torch.ps1 not found next to bootstrap: {0}' -f $torchScript)
  Warn 'Falling back to inline torch install.'
  # --no-deps: deps are already installed from the frozen requirements.txt above;
  # letting pip pull torch's deps would re-resolve and change our locked versions.
  $tArgs = @('-m','pip','install','--no-deps',$TORCH_VER,$TORCHAUDIO_VER,$TORCHVISION_VER,'--extra-index-url',$CUDA_INDEX)
  $null = Invoke-Native $VENV_PY $tArgs
}
# Verify torch by ACTUALLY importing it — the only trustworthy signal. A killed
# uv/pip (McAfee etc.) or a network error can leave torch missing while the step
# above still "finished". We report this prominently in the final summary so a
# missing torch is impossible to overlook.
# Run via a temp .py (NOT `python -c "..."`): under WinPS 5.1 native-argument
# re-parsing splits the string on spaces / strips quotes, so python receives only
# `import torch; print(` -> SyntaxError. A temp file is immune to that.
$torchProbe = @'
import torch
print("  torch", torch.__version__, "cuda_available =", torch.cuda.is_available())
'@
$torchTmp = Join-Path $env:TEMP ('ttsbroker_torchok_{0}.py' -f ([guid]::NewGuid().ToString('N')))
Set-Content -Path $torchTmp -Value $torchProbe -Encoding UTF8
& $VENV_PY -u $torchTmp
$torchRC = $LASTEXITCODE
Remove-Item $torchTmp -ErrorAction SilentlyContinue
if ($torchRC -eq 0) { $TORCH_OK = $true; Ok 'PyTorch verified (import OK).' }
else { Warn 'PyTorch is NOT importable — it did not install correctly.' }

# --- 4b. ffmpeg + ffprobe (project-local, no global footprint) ---
# UVR5 vocal separation (gsv-tools/uvr5/webui.py) and the broker's audio
# transcoding require ffmpeg/ffprobe. download_ffmpeg.py fetches a static build
# into vendor\ffmpeg\<platform>\ (idempotent: skips if already runnable). Failure
# is non-fatal here — the broker degrades to a system ffmpeg / WAV — but vocal
# separation won't work without it, so we surface the status in the final summary.
$FFMPEG_OK = $false
$ffScript = Join-Path $SCRIPT_DIR 'download_ffmpeg.py'
if (Test-Path $ffScript) {
  Info 'provisioning ffmpeg + ffprobe (project-local) ...'
  $null = Invoke-Native $VENV_PY @("$ffScript")
  & $VENV_PY "$ffScript" --check
  if ($LASTEXITCODE -eq 0) { $FFMPEG_OK = $true; Ok 'ffmpeg/ffprobe ready.' }
  else { Warn 'ffmpeg/ffprobe NOT available — UVR5 vocal separation will fail until installed.' }
} else {
  Warn ('download_ffmpeg.py not found: {0}' -f $ffScript)
}

# --- 5. self-check ---
Info 'self-check: importing core packages ...'
$check = @'
import importlib, sys, time
# Print each module BEFORE importing it (flushed immediately) so the deploy window
# shows live progress and, if one import hangs, you can see EXACTLY which module it
# is stuck on instead of staring at a silent screen.
mods = ["torch","torchaudio","numpy","librosa","soundfile","transformers",
        "jieba_fast","pyopenjtalk","ctranslate2","faster_whisper","fastapi","onnxruntime"]
bad = []
for m in mods:
    print(("    importing %-16s ... " % m), end="", flush=True)
    t = time.time()
    try:
        importlib.import_module(m)
        print("ok (%.1fs)" % (time.time() - t), flush=True)
    except Exception as e:
        print("FAILED (%.1fs)" % (time.time() - t), flush=True)
        bad.append((m, repr(e)[:120]))
try:
    import torch
    print("  torch", torch.__version__, "cuda_available=", torch.cuda.is_available(), flush=True)
except Exception as e:
    print("  torch import failed:", e, flush=True)
if bad:
    print("  MISSING/BROKEN:")
    for m, e in bad: print("    -", m, "=>", e)
    sys.exit(3)
print("  all core imports OK")
'@
$tmp = Join-Path $env:TEMP ('ttsbroker_check_{0}.py' -f ([guid]::NewGuid().ToString('N')))
Set-Content -Path $tmp -Value $check -Encoding UTF8
& $VENV_PY -u $tmp
$checkRC = $LASTEXITCODE
Remove-Item $tmp -ErrorAction SilentlyContinue
if ($checkRC -ne 0) { Warn 'some imports failed (see above). torch/CUDA or a compiled wheel may be missing.' }
else { Ok 'import self-check passed.' }

# --- best-effort: hf_transfer for faster (parallel, chunked) model downloads ---
# download_models.py auto-enables it when importable; installing it is optional.
Info 'installing hf_transfer (accelerates model downloads) ...'
if ($UV_OK) { $hfRC = Invoke-Native $VENV_PY @('-m','uv','pip','install','--python',"$VENV_PY",'hf_transfer') }
else        { $hfRC = Invoke-Native $VENV_PY @('-m','pip','install','hf_transfer') }
if ($hfRC -ne 0) { Warn 'hf_transfer install failed (non-fatal — downloads just use the default path).' }

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
Write-Host '============================================================' -ForegroundColor White
Write-Host '  部署结果小结 / Deployment summary' -ForegroundColor White
Write-Host '------------------------------------------------------------' -ForegroundColor White
Ok  '  依赖 (dependencies) : installed'
if ($TORCH_OK) {
  Ok  '  PyTorch             : OK (import verified)'
} else {
  Write-Host '  PyTorch             : MISSING / FAILED  <== 需要手动补装!' -ForegroundColor Red
  Write-Host '     修复: 双击 tools\deploy\安装PyTorch.bat  (或运行' -ForegroundColor Yellow
  Write-Host '           tools\deploy\install_torch.ps1)。若被杀毒(如迈克菲)拦截,' -ForegroundColor Yellow
  Write-Host '           先把本目录加入杀软白名单, 或先执行  set TTS_NO_UV=1  再重试。' -ForegroundColor Yellow
}
if ($FFMPEG_OK) {
  Ok  '  ffmpeg/ffprobe      : OK'
} else {
  Write-Host '  ffmpeg/ffprobe      : MISSING  <== 人声分离(UVR5)需要它!' -ForegroundColor Red
  Write-Host '     修复: venv\Scripts\python.exe tools\deploy\download_ffmpeg.py' -ForegroundColor Yellow
}
Write-Host '============================================================' -ForegroundColor White
Write-Host ''
if ($TORCH_OK) { Ok 'Bootstrap finished. You can now run 启动.bat' }
else           { Warn 'Bootstrap finished, but PyTorch is missing — install it before running 启动.bat.' }
exit 0

}
catch {
  # Any unexpected TERMINATING error lands here instead of vanishing the window.
  Write-Host ''
  Write-Host ('[deploy][FATAL] {0}' -f $_.Exception.Message) -ForegroundColor Red
  if ($_.InvocationInfo) {
    Write-Host ('  at: {0}:{1}' -f $_.InvocationInfo.ScriptName, $_.InvocationInfo.ScriptLineNumber) -ForegroundColor Red
  }
  Write-Host ('  full error saved to the transcript above.') -ForegroundColor Red
  exit 1
}
finally {
  if ($LOG_FILE) {
    try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch {}
    Write-Host ('[deploy] full log: {0}' -f $LOG_FILE) -ForegroundColor DarkCyan
  }
}
