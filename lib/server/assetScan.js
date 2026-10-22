// Full asset directory scan + voices.json sync.
// `assetScanner.fullScan()` supplies the scanned metas; this keeps voices.json
// consistent with them under the voices lock — ids no longer scanned are
// deleted, every scanned id is rewritten with display_name / language /
// prompt_lang / text_lang (defaulting to "ja"). That is the only write here;
// the asset folders themselves are never touched.

async function runFullAssetScan(assetScanner, withVoicesLock, loadVoices, saveVoices) {
  const results = assetScanner.fullScan();
  await withVoicesLock(async () => {
    const voices = loadVoices();
    const scannedIds = new Set(Object.keys(results));
    for (const oldId of Object.keys(voices)) {
      if (!scannedIds.has(oldId)) delete voices[oldId];
    }
    for (const [id, meta] of Object.entries(results)) {
      voices[id] = {
        display_name: meta?.display_name || id,
        language: meta?.language || "ja",
        prompt_lang: meta?.prompt_lang || meta?.language || "ja",
        text_lang: meta?.text_lang || meta?.language || "ja",
      };
    }
    saveVoices(voices);
  });
  return results;
}

module.exports = { runFullAssetScan };
