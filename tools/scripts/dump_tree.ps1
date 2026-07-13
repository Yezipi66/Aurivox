# dump_tree.ps1 — 导出 TTS Broker 项目结构给分发规划用 (开发者工具)
# 位置: tools\scripts\dump_tree.ps1 —— 项目根自动识别为本脚本上溯两级。
# 用法: 右键“使用 PowerShell 运行”，或:
#       powershell -ExecutionPolicy Bypass -File tools\scripts\dump_tree.ps1
#       -Root <path>   手动指定项目根 (默认自动)
# 产物:  <root>\tree_report.txt (把它发回给我即可)

param([string]$Root = '')

$ErrorActionPreference = 'SilentlyContinue'
$SCRIPT_DIR = $PSScriptRoot; if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
if ($Root) {
  $root = $Root
} else {
  # tools\scripts -> tools -> <root>; if server.js not there, fall back to script dir
  $cand = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent
  if (Test-Path (Join-Path $cand 'server.js')) { $root = $cand } else { $root = $SCRIPT_DIR }
}
$out  = Join-Path $root 'tree_report.txt'
"" | Out-File $out -Encoding UTF8

function W($s){ Add-Content -Path $out -Value $s -Encoding UTF8 }

W "==================== TTS Broker tree_report ===================="
W ("root : {0}" -f $root)
W ("time : {0}" -f (Get-Date))
W ""

# --- 1) Python / venv 信息 ---
W "==================== [1] Python / venv ===================="
$venvPy = Join-Path $root 'venv\Scripts\python.exe'
if (Test-Path $venvPy) {
  W ("venv python: {0}" -f $venvPy)
  W ("version    : {0}" -f (& $venvPy --version 2>&1))
} else { W "venv python: NOT FOUND (venv\Scripts\python.exe)" }
$sysPy = (Get-Command python -ErrorAction SilentlyContinue).Source
W ("system python: {0}" -f ($(if($sysPy){$sysPy}else{'none'})))
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
W ("system node  : {0}" -f ($(if($node){"$node  ($(node --version 2>&1))"}else{'none'})))
W ""

# --- 2) 根目录文件(一层) ---
W "==================== [2] root files (top level) ===================="
Get-ChildItem $root -Force | Sort-Object { -not $_.PSIsContainer }, Name | ForEach-Object {
  if ($_.PSIsContainer) { W ("  <DIR>  {0}" -f $_.Name) }
  else { W ("  {0,10:N0}  {1}" -f $_.Length, $_.Name) }
}
W ""

# --- 3) 关键子树(带大小，剪掉噪音目录) ---
$prune = @('node_modules','.git','.staging','__pycache__','.cache','logs','output','outputs','dist','.venv')
function Dump-Tree($base, $label){
  W ("==================== [3] tree: {0} ====================" -f $label)
  if (-not (Test-Path $base)) { W "  (not present)"; W ""; return }
  Get-ChildItem $base -Recurse -Force | Where-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\')
    $parts = $rel.Split('\')
    -not ($parts | Where-Object { $prune -contains $_ })
  } | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart('\')
    if ($_.PSIsContainer) { W ("  <DIR>  {0}\" -f $rel) }
    else { W ("  {0,12:N0}  {1}" -f $_.Length, $rel) }
  }
  W ""
}
Dump-Tree (Join-Path $root 'lib\training\gsv-tools') 'lib\training\gsv-tools (models/asr/uvr5 weights)'
Dump-Tree (Join-Path $root 'vendor') 'vendor (ffmpeg etc.)'
Dump-Tree (Join-Path $root 'wheels') 'wheels (if any)'
Dump-Tree (Join-Path $root 'tools')  'tools (if any)'
Dump-Tree (Join-Path $root 'web')    'web (source, dist excluded)'

# --- 4) 所有大二进制/模型/轮子清单(全项目，排除 venv+node_modules) ---
W "==================== [4] binaries/models/wheels inventory ===================="
$exts = '.pth','.ckpt','.pt','.onnx','.bin','.safetensors','.whl','.exe','.dll'
Get-ChildItem $root -Recurse -Force -File | Where-Object {
  $rel = $_.FullName.Substring($root.Length).TrimStart('\')
  ($exts -contains $_.Extension.ToLower()) -and
  ($rel -notmatch '\\node_modules\\') -and ($rel -notmatch '\\venv\\')
} | Sort-Object Length -Descending | ForEach-Object {
  W ("  {0,14:N0}  {1}" -f $_.Length, $_.FullName.Substring($root.Length).TrimStart('\'))
}
W ""

# --- 5) venv site-packages 里“需编译”的关键包是否装上了 ---
W "==================== [5] compiled-critical packages present? ===================="
$sp = Join-Path $root 'venv\Lib\site-packages'
$crit = 'jieba_fast','pyopenjtalk','ctranslate2','onnxruntime','onnxruntime_gpu','llvmlite','numba','av','soundfile','pyworld','opencc','sentencepiece','tokenizers'
if (Test-Path $sp) {
  foreach($c in $crit){
    $hit = Get-ChildItem $sp -Force | Where-Object { $_.Name -match ("^{0}([-_].*)?$" -f [regex]::Escape($c)) } | Select-Object -First 1
    W ("  {0,-20} {1}" -f $c, ($(if($hit){'FOUND: '+$hit.Name}else{'-- missing --'})))
  }
} else { W "  (venv site-packages not found)" }
W ""
W "==================== END ===================="
Write-Host ("Done -> {0}" -f $out)
