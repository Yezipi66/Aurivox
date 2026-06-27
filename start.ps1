[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$BASE_DIR    = $PSScriptRoot
$ENGINE_DIR  = "D:\AI\GPT-SoVITS-v2pro-20250604"
$ENGINE_PY   = Join-Path $ENGINE_DIR "runtime\python.exe"
$ENGINE_CFG  = "GPT_SoVITS/configs/tts_infer.yaml"
$ENGINE_HOST = "127.0.0.1"
$ENGINE_PORT = 9880
$BACKEND_PORT  = 9886
$FRONTEND_PORT = 5173
$ENGINE_WAIT_SECONDS = 120

try {
  if (-not $BASE_DIR) { $BASE_DIR = (Get-Location).Path }
  Write-Host "==================== TTS Broker Startup ====================" -ForegroundColor Cyan

  function Test-Port($port) { return ($null -ne (netstat -ano | Select-String ":$port\s")) }
  function Test-EngineReady {
    try {
      $null = Invoke-WebRequest -Uri "http://${ENGINE_HOST}:${ENGINE_PORT}/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      return $true
    } catch {
      if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -gt 0) { return $true }
      return $false
    }
  }

  # 1/3 Engine
  Write-Host "[1/3] GPT-SoVITS Engine (:$ENGINE_PORT) ..." -ForegroundColor Green
  if (Test-Port $ENGINE_PORT) {
    Write-Host "      Port already in use, assuming engine is running, skip." -ForegroundColor Yellow
  } else {
    $ok = $true
    if (-not (Test-Path $ENGINE_DIR)) { Write-Host "[ERROR] Engine dir missing: $ENGINE_DIR" -ForegroundColor Red; $ok=$false }
    elseif (-not (Test-Path $ENGINE_PY)) { Write-Host "[ERROR] Engine Python missing: $ENGINE_PY" -ForegroundColor Red; $ok=$false }
    elseif (-not (Test-Path (Join-Path $ENGINE_DIR "api_v2.py"))) { Write-Host "[ERROR] api_v2.py not found" -ForegroundColor Red; $ok=$false }
    elseif (-not (Test-Path (Join-Path $ENGINE_DIR $ENGINE_CFG))) { Write-Host "[ERROR] Config missing: $ENGINE_CFG" -ForegroundColor Red; $ok=$false }
    if (-not $ok) { Read-Host "Press Enter to exit"; return }

    Start-Process powershell -ArgumentList @("-NoExit","-Command","cd '$ENGINE_DIR'; & '$ENGINE_PY' api_v2.py -a $ENGINE_HOST -p $ENGINE_PORT -c '$ENGINE_CFG'") | Out-Null
    Write-Host "      Waiting for engine ready (max ${ENGINE_WAIT_SECONDS}s) ..." -ForegroundColor Gray
    $ready = $false
    for ($i=0; $i -lt $ENGINE_WAIT_SECONDS; $i++) {
      Start-Sleep -Seconds 1
      if (Test-EngineReady) { $ready=$true; break }
      if (($i+1)%10 -eq 0) { Write-Host "      ... waited $($i+1)s" -ForegroundColor DarkGray }
    }
    if ($ready) { Write-Host "      Engine is ready [OK]" -ForegroundColor Green }
    else { Write-Host "[WARN] engine did not respond in time, check engine window for errors." -ForegroundColor Yellow }
  }

  # 2/3 Backend
  Write-Host "[2/3] Backend server.js (:$BACKEND_PORT) ..." -ForegroundColor Green
  if (Test-Port $BACKEND_PORT) { Write-Host "      Port already in use, skip." -ForegroundColor Yellow }
  else { Start-Process powershell -ArgumentList @("-NoExit","-Command","cd '$BASE_DIR'; node server.js") | Out-Null; Start-Sleep -Seconds 3 }

  # 3/3 Frontend
  Write-Host "[3/3] Frontend Vite (:$FRONTEND_PORT) ..." -ForegroundColor Green
  if (Test-Port $FRONTEND_PORT) { Write-Host "      Port already in use, skip." -ForegroundColor Yellow }
  else { Start-Process powershell -ArgumentList @("-NoExit","-Command","cd '$BASE_DIR\web'; npm run dev") | Out-Null }

  Write-Host ""
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host "  Engine:   http://127.0.0.1:$ENGINE_PORT"
  Write-Host "  Backend:  http://127.0.0.1:$BACKEND_PORT"
  Write-Host "  Frontend: http://127.0.0.1:$FRONTEND_PORT"
  Write-Host "========================================" -ForegroundColor Cyan
}
catch {
  Write-Host "[FATAL] Startup script error:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
}
finally {
  Read-Host "Press Enter to close this window (services keep running)"
}
