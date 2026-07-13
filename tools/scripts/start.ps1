[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ============================================================
#  TTS Broker startup orchestrator (relocated under tools\scripts)
#  - Project root is two levels up from this script.
#  - Uses the BUNDLED portable Node (tools\runtime\node\node.exe)
#    and the deployed venv Python (venv\Scripts\python.exe).
#  - Frontend is shipped pre-built (web\dist); build only runs as
#    a fallback when dist is missing.
# ============================================================

$SCRIPT_DIR = $PSScriptRoot
if (-not $SCRIPT_DIR) { $SCRIPT_DIR = (Get-Location).Path }
# tools\scripts -> tools -> <root>
$BASE_DIR = Split-Path (Split-Path $SCRIPT_DIR -Parent) -Parent

$ENGINE_PY     = Join-Path $BASE_DIR 'venv\Scripts\python.exe'
$ENGINE_SCRIPT = Join-Path $BASE_DIR 'lib\inference\infer_server.py'
$ENGINE_CFG    = Join-Path $BASE_DIR 'lib\inference\tts_infer.yaml'
$ENGINE_HOST   = '127.0.0.1'
$ENGINE_PORT   = 9880
$BACKEND_PORT  = 9886
$BACKEND_WAIT  = 30

# --- Resolve Node: prefer bundled portable node, fall back to PATH ---
$BUNDLED_NODE = Join-Path $BASE_DIR 'tools\runtime\node\node.exe'
$BUNDLED_NPM  = Join-Path $BASE_DIR 'tools\runtime\node\npm.cmd'
if (Test-Path $BUNDLED_NODE) {
  $NODE = $BUNDLED_NODE
  $NPM  = $BUNDLED_NPM
  # ensure bundled node dir is first on PATH so npm/node child procs resolve
  $env:PATH = (Split-Path $BUNDLED_NODE -Parent) + ';' + $env:PATH
} else {
  $NODE = 'node'
  $NPM  = 'npm'
}

$LogDir = Join-Path $BASE_DIR 'logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$StartupLog = Join-Path $LogDir 'startup.log'

function Log {
  param([string]$msg, [string]$color = 'Gray')
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg
  Write-Host $line -ForegroundColor $color
  Add-Content -Path $StartupLog -Value $line -Encoding UTF8
}

function Test-Port {
  param([int]$port)
  $result = netstat -ano | Select-String (':{0}\s' -f $port)
  return ($null -ne $result)
}

function Test-HttpReady {
  param([string]$url)
  try {
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -gt 0) { return $true }
    return $false
  }
}

'==== TTS Broker startup @ {0} ====' -f (Get-Date) | Out-File -FilePath $StartupLog -Encoding UTF8
Log '==================== TTS Broker Startup ====================' 'Cyan'
Log ('root : {0}' -f $BASE_DIR) 'DarkGray'
Log ('node : {0}' -f $NODE) 'DarkGray'

# --- Guard: venv present ---
if (-not (Test-Path $ENGINE_PY)) {
  Log ('[ERROR] venv Python not found: {0}' -f $ENGINE_PY) 'Red'
  Log '        Run 首次部署.bat first.' 'Red'
  exit 1
}

# 0. Frontend: shipped pre-built. Build only as fallback when dist missing.
$webDir     = Join-Path $BASE_DIR 'web'
$distIdx    = Join-Path $webDir 'dist\index.html'
$distAssets = Join-Path $webDir 'dist\assets'

if ((-not (Test-Path $distIdx)) -or (-not (Test-Path $distAssets))) {
  Log '[build] web\dist missing -> attempting fallback build (needs bundled node).' 'Yellow'
  $hasNodeModules = Test-Path (Join-Path $webDir 'node_modules')
  if ($hasNodeModules) {
    $buildCmd = ('"{0}" run build' -f $NPM)
  } else {
    $buildCmd = ('"{0}" install && "{0}" run build' -f $NPM)
  }
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',$buildCmd) -WorkingDirectory $webDir -WindowStyle Normal -Wait
  if (Test-Path $distAssets) { Log '[build] fallback build finished [OK]' 'Green' }
  else { Log '[build][WARN] fallback build may have failed. Check the build window.' 'Red' }
} else {
  Log '[build] web\dist present (shipped pre-built). Skip build.' 'Green'
}

# 1. Backend
Log ('[1/2] Backend server.js on port {0} ...' -f $BACKEND_PORT) 'Green'
if (Test-Port $BACKEND_PORT) {
  Log ('      Port {0} already in use. Treat backend as running.' -f $BACKEND_PORT) 'Yellow'
} else {
  $beLog = Join-Path $LogDir 'backend.log'
  $beErr = Join-Path $LogDir 'backend.err.log'
  Start-Process -FilePath $NODE -ArgumentList @('server.js') -WorkingDirectory $BASE_DIR -WindowStyle Hidden -RedirectStandardOutput $beLog -RedirectStandardError $beErr | Out-Null
  Log ('      Backend started in background. Waiting up to {0}s ...' -f $BACKEND_WAIT) 'Gray'
}

$backendUrl = 'http://127.0.0.1:{0}/' -f $BACKEND_PORT
$ready = $false
for ($i = 0; $i -lt $BACKEND_WAIT; $i++) {
  Start-Sleep -Seconds 1
  if (Test-HttpReady $backendUrl) { $ready = $true; break }
}
if ($ready) { Log '      Backend ready [OK]. Opening browser.' 'Green' }
else { Log ('      [WARN] Backend not ready in {0}s. Opening browser anyway. See logs\backend*.log.' -f $BACKEND_WAIT) 'Yellow' }
Start-Process $backendUrl | Out-Null

# 2. Inference engine
Log ('[2/2] Inference service on port {0} ...' -f $ENGINE_PORT) 'Green'
if (Test-Port $ENGINE_PORT) {
  Log ('      Port {0} already in use. Treat engine as running.' -f $ENGINE_PORT) 'Yellow'
} else {
  $ok = $true
  if (-not (Test-Path $ENGINE_SCRIPT)) { Log ('      [ERROR] Missing infer_server.py: {0}' -f $ENGINE_SCRIPT) 'Red'; $ok = $false }
  if ($ok) {
    $infLog = Join-Path $LogDir 'inference.log'
    $infErr = Join-Path $LogDir 'inference.err.log'
    $engineArgs = @($ENGINE_SCRIPT, '-a', $ENGINE_HOST, '-p', "$ENGINE_PORT", '-c', $ENGINE_CFG)
    Start-Process -FilePath $ENGINE_PY -ArgumentList $engineArgs -WorkingDirectory $BASE_DIR -WindowStyle Hidden -RedirectStandardOutput $infLog -RedirectStandardError $infErr | Out-Null
    Log '      Inference service started in background.' 'Gray'
    Log '      See logs\inference.log / logs\inference.err.log for loading progress.' 'DarkGray'
  }
}

Log '========================================' 'Cyan'
Log ('  UI      : http://127.0.0.1:{0}  opened in browser' -f $BACKEND_PORT) 'Yellow'
Log ('  Backend : http://127.0.0.1:{0}  logs\backend.log' -f $BACKEND_PORT)
Log ('  Engine  : http://127.0.0.1:{0}  logs\inference.log' -f $ENGINE_PORT)
Log '  Launcher will exit. Backend and inference stay running in background.' 'Cyan'
Log '========================================' 'Cyan'
