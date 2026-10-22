// Full asset directory scan + voices.json sync. Scans the assets directory,
// upserts found voices, and removes voices whose files are gone. Runs under
// a voices lock to avoid concurrent reads/writes.

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
