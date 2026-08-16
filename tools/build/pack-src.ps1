# pack-src.ps1 — 打包 TTS Broker 纯源码为 zip (开发者工具)
# 位置: tools\Build\pack-src.ps1 —— 项目根自动识别为本脚本上溯两级。
# 通常经同目录的 pack-src.bat 唤起；也可直接:
#   powershell -ExecutionPolicy Bypass -File tools\Build\pack-src.ps1
# 参数:
#   -Out <path>     指定输出 zip 路径 (默认 <root>\tts-broker-src[-时间戳].zip)
#   -NoTimestamp    输出文件名不带时间戳 (固定为 tts-broker-src.zip)
# 产物: 仅含源码 (lib / web\src / tools\scripts + 少量顶层文件)，
#       排除 node_modules / dist / venv / 模型 / 音频等重产物。

param(
  [string]$Out = '',
  [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'

# --- 定位项目根: tools\Build -> tools -> <root> ---
$SCRIPT_DIR = $PSScriptRoot; if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
$root = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent
if (-not (Test-Path (Join-Path $root 'server.js'))) {
  Write-Host "[!] 未在 $root 找到 server.js，请从项目内运行本脚本。" -ForegroundColor Red
  exit 1
}
Push-Location $root
try {
  # --- 输出路径 ---
  if (-not $Out) {
    $name = if ($NoTimestamp) { 'tts-broker-src.zip' }
            else { 'tts-broker-src-{0}.zip' -f (Get-Date -Format 'yyyyMMdd-HHmmss') }
    $Out = Join-Path $root $name
  }

  # --- 临时暂存目录 ---
  $stage = Join-Path $env:TEMP ('ttsb_src_' + [guid]::NewGuid().ToString('N').Substring(0,8))
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

  # scripts\ 已并入 tools\（第 0.5 步），CHANGELOG 与内部文档已移入 docs\（同上），
  # 运行期数据已并入 data\（第 2 步）——三处都随之更新，否则打出来的包会缺件。
  $srcDirs  = 'lib', 'web', 'docs', 'tools\build', 'tools\checks', 'tools\scripts', 'tools\tests'
  $excludeD = 'node_modules dist build __pycache__ .git pretrained runtime models venv .venv .staging assets logs output outputs backups tmp temp voices data .cache'.Split(' ')
  $excludeF = '*.pth *.ckpt *.safetensors *.bin *.pt *.onnx *.wav *.mp3 *.flac *.m4a *.ogg *.opus *.npy *.npz *.zip *.7z *.exe *.dll *.pdb *.mp4 *.mov *.avi *.mkv'.Split(' ')
  $topFiles = 'README.md', 'GUIDANCE.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES', '.env.example', 'requirements.txt', 'package.json', 'package-lock.json', 'deploy.bat', 'start.bat', 'stop.bat', 'server.js', 'tools\run_tests.cjs'
  # data\ 整体属于每台机器自己的运行期状态，只有随包分发的默认值文件例外。
  $dataFiles = 'data\advanced_params.json', 'data\training_defaults.json'

  Write-Host "==> 源码目录:" -ForegroundColor Cyan
  foreach ($d in $srcDirs) {
    if (Test-Path $d) {
      Write-Host "    + $d"
      robocopy $d (Join-Path $stage $d) /E /XD $excludeD /XF $excludeF /NFL /NDL /NJH /NJS /NP | Out-Null
    }
  }

  Write-Host "==> 随包分发的默认值:" -ForegroundColor Cyan
  foreach ($f in $dataFiles) {
    if (Test-Path $f) {
      Write-Host "    + $f"
      $dest = Join-Path $stage $f
      New-Item (Split-Path $dest) -ItemType Directory -Force | Out-Null
      Copy-Item $f $dest -Force
    } else {
      Write-Host "    [警告] 缺少 $f" -ForegroundColor Yellow
    }
  }

  Write-Host "==> 顶层文件:" -ForegroundColor Cyan
  foreach ($f in $topFiles) {
    if (Test-Path $f) {
      Write-Host "    + $f"
      $dest = Join-Path $stage $f
      New-Item (Split-Path $dest) -ItemType Directory -Force | Out-Null
      Copy-Item $f $dest -Force
    }
  }

  # --- 压缩 ---
  if (Test-Path $Out) { Remove-Item $Out -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Out -Force
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

  $mb = [math]::Round((Get-Item $Out).Length / 1MB, 2)
  Write-Host ""
  Write-Host "[OK] 已生成: $Out" -ForegroundColor Green
  Write-Host "     体积: $mb MB" -ForegroundColor Green
}
finally {
  Pop-Location
}
