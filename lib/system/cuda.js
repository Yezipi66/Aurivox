// ===========================
//  CUDA / GPU DETECTION
// ===========================
// Extracted verbatim from server.js (Stage-0 refactor). Probes the project
// venv's torch ONCE (asynchronously) for CUDA availability + device info and
// caches the result. Powers the right-hand-corner status light and the training
// pre-flight warnings (no-GPU block / low-VRAM notice). We do NOT auto-tune any
// training params from this — it is advisory only.
//
// The probe runs via async spawn (never execFileSync) so importing torch — which
// can take several seconds — does not block Node's event loop / other requests.
// `ready:false` until the probe resolves; callers should treat "not ready" as
// "unknown" (don't gate on it). Any failure (no venv yet, torch missing, timeout)
// degrades to "CUDA unavailable" so /api/health always answers.

const { spawn } = require("child_process");
const { getPythonPath, getCleanEnv } = require("../training/python_helper");

let _cudaProbeStarted = false;
let _cudaInfo = { ready: false, available: false, device_name: null, vram_gb: null };

function startCudaProbe() {
  if (_cudaProbeStarted) return;
  _cudaProbeStarted = true;
  let py;
  try { py = getPythonPath(); } catch { py = "python"; }
  // Emit a single JSON line so parsing is unaffected by any torch warnings.
  const probe = [
    "import json",
    "o={'available':False,'device_name':None,'vram_gb':None}",
    "try:",
    "    import torch",
    "    if torch.cuda.is_available():",
    "        p=torch.cuda.get_device_properties(0)",
    "        o['available']=True",
    "        o['device_name']=p.name",
    "        o['vram_gb']=round(p.total_memory/(1024**3),1)",
    "except Exception:",
    "    pass",
    "print('CUDA_PROBE='+json.dumps(o))",
  ].join("\n");

  let child;
  try {
    child = spawn(py, ["-c", probe], { env: getCleanEnv() });
  } catch {
    _cudaInfo = { ready: true, available: false, device_name: null, vram_gb: null };
    return;
  }
  let buf = "";
  const finish = (info) => {
    _cudaInfo = { ready: true, ...info };
    if (_cudaInfo.available) {
      console.log(`[cuda] ${_cudaInfo.device_name} (${_cudaInfo.vram_gb}GB)`);
    } else {
      console.log("[cuda] not available — inference will run on CPU; fine-tuning is not recommended");
    }
  };
  const kill = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
  child.stdout.on("data", (d) => { buf += d.toString(); });
  child.on("error", () => { clearTimeout(kill); finish({ available: false, device_name: null, vram_gb: null }); });
  child.on("close", () => {
    clearTimeout(kill);
    try {
      const m = /CUDA_PROBE=(\{.*\})/.exec(buf);
      if (m) {
        const p = JSON.parse(m[1]);
        return finish({ available: !!p.available, device_name: p.device_name || null, vram_gb: p.vram_gb ?? null });
      }
    } catch {}
    finish({ available: false, device_name: null, vram_gb: null });
  });
}

function detectCuda() {
  startCudaProbe();
  return _cudaInfo;
}

module.exports = { startCudaProbe, detectCuda };
