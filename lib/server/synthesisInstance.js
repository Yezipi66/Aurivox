// Synthesis module instantiation.
// Creates segmentCache and synthesis module with injected singletons.

const { createSegmentCache } = require("../cache/segmentCache");
const { createSynthesisModule } = require("./synthesis");
const { Mutex } = require("../util/mutex");
const { HttpError } = require("../http/http");
const { WeightSwitch } = require("../engines/weightSwitch");

function createSynthesisInstance(process, PATHS, { engineSupervisor = null } = {}) {
  const _GEN_MAX_QUEUE = (() => {
    const n = parseInt(process.env.AURIVOX_MAX_QUEUE, 10);
    return (Number.isInteger(n) && n >= 0) ? n : 32;
  })();
  const _GEN_RETRY_AFTER = (() => {
    const n = parseInt(process.env.AURIVOX_RETRY_AFTER, 10);
    return (Number.isInteger(n) && n >= 1) ? n : 3;
  })();
  const _generationMutex = new Mutex({ maxPending: _GEN_MAX_QUEUE });
  const _weightSwitch = new WeightSwitch(require("../gsv/client").gsvGet);
  const segmentCache = createSegmentCache({
    dir: PATHS.CACHE.segments,
    enabled: process.env.AURIVOX_CACHE !== "0",
  });
  const synthesis = createSynthesisModule({ _weightSwitch, segmentCache, engineSupervisor });
  return { _GEN_MAX_QUEUE, _GEN_RETRY_AFTER, _generationMutex, _weightSwitch, segmentCache, synthesis };
}

module.exports = { createSynthesisInstance };
