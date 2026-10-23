// Engine supervisor setup.
// Wires EngineSupervisor with spawn/probe/mem/ledger callbacks.

const { EngineSupervisor } = require("../engines/supervisor");
const { spawnFromPlan, probeOnce } = require("../engines/spawnEngine");
const { buildLaunchPlan: _buildLaunchPlan } = require("../engines/launchPlan");
const _memprobe = require("../engines/memprobe");
const _memledger = require("../engines/memledger");

function createEngineSupervisor(__dirname, process, { resolveEngineProfile, console }) {
  const _engineSupervisor = new EngineSupervisor({
    spawn: (plan) => spawnFromPlan(plan, { rootDir: __dirname }),
    probe: (url, timeoutMs) => probeOnce(url, timeoutMs),
    buildPlan: (profile, opts) => _buildLaunchPlan(profile, Object.assign({ rootDir: __dirname }, opts)),
    loadProfile: (id) => resolveEngineProfile(id),
    log: (line) => console.log(line),
    env: process.env,
    mem: {
      freeMb: () => _memprobe.freeMb(),
      sampleTree: (pid) => _memprobe.sampleTree(pid),
    },
    ledger: {
      needMb: (id) => _memledger.needMb(__dirname, id),
      record: (id, mb) => _memledger.record(__dirname, id, mb),
      markAttempting: (id) => _memledger.markAttempting(__dirname, id),
      reapAttempts: () => _memledger.reapAttempts(__dirname),
      attemptingIds: () => Object.keys((_memledger.load(__dirname) || {}).attempting || {}),
    },
  });
  try {
    _engineSupervisor.reapCrashes();
  } catch (err) {
    console.warn("[engine] 结上一轮的内存账时出错，忽略：" + ((err && err.message) || err));
  }
  const _engineSweepTimer = setInterval(() => {
    try { _engineSupervisor.sweep(); } catch (err) { console.warn("[engine] 清扫出错：" + ((err && err.message) || err)); }
  }, 60000);
  if (_engineSweepTimer.unref) _engineSweepTimer.unref();
  return _engineSupervisor;
}

module.exports = { createEngineSupervisor };
