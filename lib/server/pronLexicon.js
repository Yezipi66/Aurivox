// Pronunciation lexicon path resolution and I/O.
// Extracted from server.js (P0 refactor).

const fs = require("fs");
const path = require("path");

function pronLexiconPath(PRON_LEXICON_DIR, lang) {
  const safe = String(lang || "zh").toLowerCase().replace(/[^a-z_]/g, "") || "zh";
  return path.join(PRON_LEXICON_DIR, safe + ".json");
}

function loadPronLexicon(PRON_LEXICON_DIR, lang) {
  try {
    const p = pronLexiconPath(PRON_LEXICON_DIR, lang);
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
  } catch (e) {
    console.error("[pron] load lexicon failed:", e.message);
    return {};
  }
}

function savePronLexicon(PRON_LEXICON_DIR, lang, data) {
  fs.mkdirSync(PRON_LEXICON_DIR, { recursive: true });
  const p = pronLexiconPath(PRON_LEXICON_DIR, lang);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
  return data;
}

module.exports = { pronLexiconPath, loadPronLexicon, savePronLexicon };
