// Training version helpers. Extracted from server.js (P0 refactor).

const { versionFromName, normalizeVersion } = require("../training/version");

function pickLatestByEpoch(files, re) {
  let best = null, bestE = -1;
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const e = parseInt(m[1], 10);
    if (e > bestE) { bestE = e; best = f; }
  }
  return best ? { file: best, epoch: bestE } : null;
}

module.exports = { versionFromName, normalizeVersion, pickLatestByEpoch };
