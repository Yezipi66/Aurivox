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

  $srcDirs  = 'lib', 'web\src', 'tools\scripts', 'tools\Build'
  $excludeD = 'node_modules dist __pycache__ .git pretrained runtime models venv logs .cache'.Split(' ')
  $excludeF = '*.pth *.ckpt *.safetensors *.bin *.pt *.onnx *.wav *.mp3 *.flac *.opus *.npy *.zip *.7z *.exe *.dll *.mp4'.Split(' ')
  $topFiles = 'server.js', 'package.json', 'web\index.html', 'web\package.json', 'web\vite.config.js'

  Write-Host "==> 源码目录:" -ForegroundColor Cyan
  foreach ($d in $srcDirs) {
    if (Test-Path $d) {
      Write-Host "    + $d"
      robocopy $d (Join-Path $stage $d) /E /XD $excludeD /XF $excludeF /NFL /NDL /NJH /NJS /NP | Out-Null
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
