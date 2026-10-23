// Training version helpers.
// Parses version labels from checkpoint filenames and normalises version strings.
// Re-exports `versionFromName` / `normalizeVersion` from lib/training/version
// and adds `pickLatestByEpoch` to select the highest-epoch file matching a regex.

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
