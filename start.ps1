[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# TTS Broker startup orchestrator

$BASE_DIR = $PSScriptRoot
if (-not $BASE_DIR) {
  $BASE_DIR = (Get-Location).Path
}

$ENGINE_PY     = Join-Path $BASE_DIR 'venv\Scripts\python.exe'
$ENGINE_SCRIPT = Join-Path $BASE_DIR 'lib\inference\infer_server.py'
$ENGINE_CFG    = Join-Path $BASE_DIR 'lib\inference\tts_infer.yaml'
$ENGINE_HOST   = '127.0.0.1'
$ENGINE_PORT   = 9880
$BACKEND_PORT  = 9886
$BACKEND_WAIT  = 30

$LogDir = Join-Path $BASE_DIR 'logs'
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$StartupLog = Join-Path $LogDir 'startup.log'

function Log {
  param(
    [string]$msg,
    [string]$color = 'Gray'
  )

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
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -gt 0) {
      return $true
    }
    return $false
  }
}

'==== TTS Broker startup @ {0} ====' -f (Get-Date) | Out-File -FilePath $StartupLog -Encoding UTF8
Log '==================== TTS Broker Startup ====================' 'Cyan'

# 0. Build frontend when dist is missing or outdated

$webDir     = Join-Path $BASE_DIR 'web'
$distIdx    = Join-Path $webDir 'dist\index.html'
$distAssets = Join-Path $webDir 'dist\assets'

$needBuild = (-not (Test-Path $distIdx)) -or (-not (Test-Path $distAssets))

if (-not $needBuild) {
  $srcDir = Join-Path $webDir 'src'

  if (Test-Path $srcDir) {
    $newestSrc = Get-ChildItem $srcDir -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1

    $distTime = (Get-Item $distIdx).LastWriteTime

    if ($newestSrc -and $newestSrc.LastWriteTime -gt $distTime) {
      $needBuild = $true
    }
  }
}

if ($needBuild) {
  Log '[build] Frontend build required. Build window will be shown.' 'Yellow'

  $hasNodeModules = Test-Path (Join-Path $webDir 'node_modules')

  if ($hasNodeModules) {
    $buildArgs = @('/d', '/c', 'npm run build')
  } else {
    $buildArgs = @('/d', '/c', 'npm install && npm run build')
  }

  Start-Process -FilePath 'cmd.exe' -ArgumentList $buildArgs -WorkingDirectory $webDir -WindowStyle Normal -Wait

  if (Test-Path $distAssets) {
    Log '[build] Frontend build finished [OK]' 'Green'
  } else {
    Log '[build][WARN] Frontend build may have failed. Check build window output.' 'Red'
  }
} else {
  Log '[build] Frontend dist is up to date. Skip build.' 'Green'
}

# 1. Start backend first

Log ('[1/2] Backend server.js on port {0} ...' -f $BACKEND_PORT) 'Green'

if (Test-Port $BACKEND_PORT) {
  Log ('      Port {0} is already in use. Treat backend as already running.' -f $BACKEND_PORT) 'Yellow'
} else {
  $beLog = Join-Path $LogDir 'backend.log'
  $beErr = Join-Path $LogDir 'backend.err.log'

  Start-Process -FilePath 'node' -ArgumentList @('server.js') -WorkingDirectory $BASE_DIR -WindowStyle Hidden -RedirectStandardOutput $beLog -RedirectStandardError $beErr | Out-Null

  Log ('      Backend started in background. Waiting up to {0}s for readiness...' -f $BACKEND_WAIT) 'Gray'
}

$backendUrl = 'http://127.0.0.1:{0}/' -f $BACKEND_PORT
$ready = $false

for ($i = 0; $i -lt $BACKEND_WAIT; $i++) {
  Start-Sleep -Seconds 1

  if (Test-HttpReady $backendUrl) {
    $ready = $true
    break
  }
}

if ($ready) {
  Log '      Backend ready [OK]. Opening browser.' 'Green'
} else {
  Log ('      [WARN] Backend did not respond within {0}s. Opening browser anyway. Check logs\backend.log and logs\backend.err.log.' -f $BACKEND_WAIT) 'Yellow'
}

Start-Process $backendUrl | Out-Null

# 2. Start inference service in background

Log ('[2/2] Inference service on port {0} ...' -f $ENGINE_PORT) 'Green'

if (Test-Port $ENGINE_PORT) {
  Log ('      Port {0} is already in use. Treat inference service as already running.' -f $ENGINE_PORT) 'Yellow'
} else {
  $ok = $true

  if (-not (Test-Path $ENGINE_PY)) {
    Log ('      [ERROR] Missing venv Python: {0}' -f $ENGINE_PY) 'Red'
    $ok = $false
  } elseif (-not (Test-Path $ENGINE_SCRIPT)) {
    Log ('      [ERROR] Missing infer_server.py: {0}' -f $ENGINE_SCRIPT) 'Red'
    $ok = $false
  }

  if ($ok) {
    $infLog = Join-Path $LogDir 'inference.log'
    $infErr = Join-Path $LogDir 'inference.err.log'

    $engineArgs = @(
      $ENGINE_SCRIPT,
      '-a', $ENGINE_HOST,
      '-p', "$ENGINE_PORT",
      '-c', $ENGINE_CFG
    )

    Start-Process -FilePath $ENGINE_PY -ArgumentList $engineArgs -WorkingDirectory $BASE_DIR -WindowStyle Hidden -RedirectStandardOutput $infLog -RedirectStandardError $infErr | Out-Null

    Log '      Inference service started in background.' 'Gray'
    Log '      Check logs\inference.log and logs\inference.err.log for loading progress.' 'DarkGray'
  }
}

Log '========================================' 'Cyan'
Log ('  UI      : http://127.0.0.1:{0}  opened in browser' -f $BACKEND_PORT) 'Yellow'
Log ('  Backend : http://127.0.0.1:{0}  logs\backend.log' -f $BACKEND_PORT)
Log ('  Engine  : http://127.0.0.1:{0}  logs\inference.log' -f $ENGINE_PORT)
Log '  Launcher will exit. Backend and inference stay running in background.' 'Cyan'
Log '========================================' 'Cyan'