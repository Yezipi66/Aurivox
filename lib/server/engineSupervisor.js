// Engine supervisor setup.
// Wires EngineSupervisor with spawn/probe/mem/ledger callbacks.

const { EngineSupervisor } = require("../engines/supervisor");
const { spawnFromPlan, probeOnce, probeStdio } = require("../engines/spawnEngine");
const { buildLaunchPlan: _buildLaunchPlan } = require("../engines/launchPlan");
const { requireEngine } = require("../engines/registry");
const { deviceLoadParams } = require("../engines/deviceChoice");
const _memprobe = require("../engines/memprobe");
const _memledger = require("../engines/memledger");

function createEngineSupervisor(__dirname, process, { resolveEngineProfile, console }) {
  const _engineSupervisor = new EngineSupervisor({
    spawn: (plan) => spawnFromPlan(plan, { rootDir: __dirname }),
    // 走 stdio 的引擎没有 ready_url：探活经它自己的管道问 ready_endpoint。
    probe: (url, timeoutMs, where) => {
      const plan = where && where.plan;
      if (plan && plan.transport === "stdio") {
        return probeStdio(where.proc && where.proc.stdioTransport, plan.ready_endpoint, timeoutMs);
      }
      return probeOnce(url, timeoutMs);
    },
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
  // 运行设备属于启动期：把平台记下的选卡换算好，并进 ensure 的 loadParams。
  //   挂在 ensure 这一层而不是 buildPlan：startupKeyOf 也读同一份 opts，改卡才会换
  //   startupKey、supervisor 才会重开进程。显式传进来的 loadParams 优先于平台记录。
  const _ensure = _engineSupervisor.ensure.bind(_engineSupervisor);
  _engineSupervisor.ensure = (profile, selection, opts = {}) => {
    let call = {};
    if (profile && profile.id) {
      try { call = requireEngine(profile.id).call || {}; } catch (_) { /* 名片读不到就不带设备 */ }
    }
    const device = deviceLoadParams(profile && profile.id, call);
    return _ensure(profile, selection, Object.assign({}, opts, {
      loadParams: Object.assign({}, device, opts && opts.loadParams),
    }));
  };
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
