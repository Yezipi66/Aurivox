// Engine launch defaults: version, half-precision flag, device target.
// These are the values server.js passes to the engine spawner on cold start.

const ENGINE_LAUNCH_DEFAULTS = {
  version: "v2Pro",
  is_half: true,
  device: "cuda",
};

module.exports = { ENGINE_LAUNCH_DEFAULTS };
