// 读音词典快照：把 data/pron_lexicon/{lang}.json 录成自包含记录，保证重跑可复现。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PRON_LEXICON_DIR } = require('../../paths');
// Inline the full lexicon content below this size; above it, keep only
// hash + entryCount (mark truncated). Real lexicons are tiny; this only
// guards against a pathologically large file bloating task.json.
const PRON_LEXICON_INLINE_MAX = 256 * 1024;

// Snapshot every data/pron_lexicon/{lang}.json into a self-contained record so a
// later full re-run is deterministic: changing the (global, mutable) lexicon and
// re-running would silently produce a different model, but the old task.json would
// not record which lexicon version was used. We capture content + SHA-256 (content
// = true reproduction, hash = cheap comparison). Never throws — a missing dir or a
// bad file degrades to an empty/partial snapshot rather than failing the run.
function snapshotPronLexicon(language) {
  const snap = {
    capturedAt: new Date().toISOString(),
    dir: PRON_LEXICON_DIR,
    language: language || null,   // training language, for reference
    files: {},
  };
  let names = [];
  try { names = fs.readdirSync(PRON_LEXICON_DIR).filter(n => n.endsWith('.json')); }
  catch (_) { return snap; }  // dir absent = no overrides in effect
  for (const name of names) {
    const lang = name.replace(/\.json$/, '');
    const full = path.join(PRON_LEXICON_DIR, name);
    try {
      const raw = fs.readFileSync(full);
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      let entries = null, entryCount = 0, truncated = false;
      try {
        const parsed = JSON.parse(raw.toString('utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entryCount = Object.keys(parsed).length;
          if (raw.length <= PRON_LEXICON_INLINE_MAX) entries = parsed;
          else truncated = true;
        }
      } catch (_) { /* unparseable — keep bytes/hash only */ }
      snap.files[lang] = { path: full, sha256, entryCount, ...(entries ? { entries } : {}), ...(truncated ? { truncated: true } : {}) };
    } catch (_) { /* unreadable file — skip */ }
  }
  return snap;
}

module.exports = { snapshotPronLexicon };
