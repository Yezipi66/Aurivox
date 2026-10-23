// Synthesis module instantiation.
// Creates segmentCache and synthesis module with injected singletons.

const { createSegmentCache } = require("../cache/segmentCache");
const { createSynthesisModule } = require("./synthesis");
const { Mutex } = require("../util/mutex");
const { HttpError } = require("../http/http");
const { ModelSwitcher } = require("../gsv/modelState");

function createSynthesisInstance(process, PATHS) {
  const _GEN_MAX_QUEUE = (() => {
    const n = parseInt(process.env.AURIVOX_MAX_QUEUE, 10);
    return (Number.isInteger(n) && n >= 0) ? n : 32;
  })();
  const _GEN_RETRY_AFTER = (() => {
    const n = parseInt(process.env.AURIVOX_RETRY_AFTER, 10);
    return (Number.isInteger(n) && n >= 1) ? n : 3;
  })();
  const _generationMutex = new Mutex({ maxPending: _GEN_MAX_QUEUE });
  const _modelSwitcher = new ModelSwitcher(require("../gsv/client").gsvGet);
  const segmentCache = createSegmentCache({
    dir: PATHS.CACHE.segments,
    enabled: process.env.AURIVOX_CACHE !== "0",
  });
  const synthesis = createSynthesisModule({ _modelSwitcher, segmentCache });
  return { _GEN_MAX_QUEUE, _GEN_RETRY_AFTER, _generationMutex, _modelSwitcher, segmentCache, synthesis };
}

module.exports = { createSynthesisInstance };
