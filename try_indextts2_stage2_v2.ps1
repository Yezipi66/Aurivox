#requires -Version 5.1
# ============================================================
#  try_indextts2_stage2.ps1   (ASCII-only; avoids WinPS 5.1 GBK mojibake)
#
#  STAGE 2: real synthesis smoke test for IndexTTS2 on the EXISTING
#  torch 2.2 venv. Stage 1 (import) already PASSED. This actually
#  loads all checkpoints and synthesizes one line to a WAV, so it
#  surfaces the true torch-2.2 risks: checkpoint load, GPT/S2Mel
#  forward, BigVGAN vocoding, VRAM, and speed.
#
#  It NEVER touches torch/torchaudio. venv_bak is your safety net.
#
#  Usage (from D:\Project\tts_broker_openai_compat):
#    powershell -ExecutionPolicy Bypass -File try_indextts2_stage2.ps1 `
#        -IndexRepo D:\AI\index-tts
#
#  Options:
#    -RefWav  <path>   speaker reference wav (default: auto-pick from <repo>\examples)
#    -Text    "..."    text to synthesize (default: a short zh line)
#    -Fp16             use FP16 (lower VRAM; recommended on <=8GB cards)
#    -CudaKernel       enable BigVGAN custom CUDA kernel (compiles at runtime; risky on 2.2)
#    -Device  cuda:0   device (default cuda:0; use cpu to isolate CUDA issues)
# ============================================================
param(
  [string]$IndexRepo   = 'D:\AI\index-tts',
  [string]$ProjectRoot = 'D:\Project\tts_broker_openai_compat',
  [string]$RefWav      = '',
  [string]$Text        = 'Da jia hao, zhe shi IndexTTS2 zai torch 2.2 shang de yi ci zhen shi he cheng ce shi.',
  [string]$Device      = 'cuda:0',
  [switch]$Fp16,
  [switch]$CudaKernel
)

$ErrorActionPreference = 'Continue'
function Info($m){ Write-Host ('[s2] ' + $m) -ForegroundColor Cyan }
function Ok($m){   Write-Host ('[s2] ' + $m) -ForegroundColor Green }
function Warn($m){ Write-Host ('[s2] ' + $m) -ForegroundColor Yellow }
function Die($m){  Write-Host ('[s2][STOP] ' + $m) -ForegroundColor Red; exit 1 }

$PY = Join-Path $ProjectRoot 'venv\Scripts\python.exe'
if (-not (Test-Path $PY)) { Die ('venv python not found: ' + $PY) }
if (-not (Test-Path $IndexRepo)) { Die ('IndexRepo not found: ' + $IndexRepo) }

$CfgPath   = Join-Path $IndexRepo 'checkpoints\config.yaml'
$ModelDir  = Join-Path $IndexRepo 'checkpoints'
if (-not (Test-Path $CfgPath)) {
  Die ('checkpoints\config.yaml not found under ' + $ModelDir + ' -- download the IndexTTS-2 checkpoints there first.')
}

# --- pick a reference wav if not supplied ---
if (-not $RefWav) {
  $exDir = Join-Path $IndexRepo 'examples'
  if (Test-Path $exDir) {
    $cand = Get-ChildItem -Path $exDir -Filter *.wav -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cand) { $RefWav = $cand.FullName }
  }
}
if (-not $RefWav -or -not (Test-Path $RefWav)) {
  Die ('No reference wav. Pass -RefWav <path-to-15s-or-shorter-wav>. (none found in <repo>\examples)')
}
Info ('reference wav   = ' + $RefWav)
Info ('checkpoints dir = ' + $ModelDir)
Info ('device          = ' + $Device)
Info ('fp16            = ' + [bool]$Fp16)
Info ('cuda_kernel     = ' + [bool]$CudaKernel)

$OutWav = Join-Path $ProjectRoot ('indextts2_stage2_out.wav')

# --- torch guard: confirm still 2.2 before we begin ---
$tv = & $PY -c "import torch;print(torch.__version__)" 2>$null
Info ('torch = ' + $tv)

# --- build the python probe ---
$useFp16   = if ($Fp16)       { 'True' } else { 'False' }
$useKernel = if ($CudaKernel) { 'True' } else { 'False' }

$probe = @"
import sys, time, traceback, os

# Prefer a reliable HF mirror so 2GB aux models don't die on IncompleteRead.
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

RC = 0
try:
    import torch, torchaudio
    print('  torch', torch.__version__, 'torchaudio', torchaudio.__version__,
          'cuda_avail', torch.cuda.is_available())

    # --- torch 2.2 compat shims for APIs added in 2.3+ that transformers 4.52 calls ---
    if not hasattr(torch, 'get_default_device'):
        def _get_default_device():
            try:
                return torch.empty(0).device
            except Exception:
                return torch.device('cpu')
        torch.get_default_device = _get_default_device
        print('  [shim] added torch.get_default_device (2.3+ API missing on 2.2)')
    dev = r'''$Device'''
    if dev.startswith('cuda') and not torch.cuda.is_available():
        print('  [warn] cuda not available, falling back to cpu'); dev = 'cpu'

    from indextts.infer_v2 import IndexTTS2
    t0 = time.time()
    tts = IndexTTS2(
        cfg_path=r'''$CfgPath''',
        model_dir=r'''$ModelDir''',
        use_fp16=$useFp16,
        use_cuda_kernel=$useKernel,
        use_deepspeed=False,
        device=(None if dev=='auto' else dev),
    )
    print('  MODEL_LOAD_OK in %.1fs' % (time.time()-t0))

    if dev.startswith('cuda'):
        torch.cuda.reset_peak_memory_stats()

    t1 = time.time()
    tts.infer(
        spk_audio_prompt=r'''$RefWav''',
        text=r'''$Text''',
        output_path=r'''$OutWav''',
        verbose=True,
    )
    dt = time.time()-t1
    print('  SYNTH_OK in %.1fs' % dt)

    if dev.startswith('cuda'):
        peak = torch.cuda.max_memory_allocated()/(1024**3)
        print('  PEAK_VRAM_GB %.2f' % peak)

    op = r'''$OutWav'''
    if os.path.exists(op) and os.path.getsize(op) > 1000:
        print('  OUTPUT_WAV_BYTES', os.path.getsize(op))
        print('RESULT: SYNTH_PASS')
    else:
        print('  output wav missing or too small:', op)
        print('RESULT: SYNTH_FAIL')
        RC = 4
except Exception:
    traceback.print_exc()
    print('RESULT: SYNTH_FAIL')
    RC = 3
sys.exit(RC)
"@

$tmp = Join-Path $env:TEMP ('idx2_s2_' + [guid]::NewGuid().ToString('N') + '.py')
Set-Content -Path $tmp -Value $probe -Encoding UTF8
Info 'running real synthesis (this loads ~5-8GB of checkpoints; first run is slow) ...'
Write-Host ''
& $PY -u $tmp
$rc = $LASTEXITCODE
Remove-Item $tmp -ErrorAction SilentlyContinue

Write-Host ''
if ($rc -eq 0) {
  Ok  ('STAGE 2 PASS: IndexTTS2 synthesized on torch 2.2. Output: ' + $OutWav)
  Info 'Listen to the wav. If it sounds right, torch 2.2 runs IndexTTS2 end-to-end.'
} else {
  Warn 'STAGE 2 FAIL: it broke during load or synthesis (see traceback above).'
  Warn 'Paste the full traceback back to me. Classification hints:'
  Warn '  * CUDA kernel / ninja / nvcc compile error  => rerun WITHOUT -CudaKernel (default is off)'
  Warn '  * out of memory                              => add -Fp16, or -Device cpu to isolate'
  Warn '  * state_dict / size mismatch                 => checkpoints incomplete or wrong version'
  Warn '  * AttributeError / needs torch>=2.x API      => real 2.2 gap; note the symbol'
  Warn '  * undefined symbol / ABI (compiled ext)      => native ext incompatible with 2.2'
}
Write-Host ''
Info 'To restore a clean SoVITS env: replace venv with venv_bak.'
