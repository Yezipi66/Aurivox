// Recipe role validation. Extracted from server.js (P0 refactor).

function createKnownVoice(isBaseVoice, loadVoices) {
  function knownVoice(role) {
    if (isBaseVoice(role)) return true;
    try { return Object.prototype.hasOwnProperty.call(loadVoices(), role); }
    catch (_) { return false; }
  }
  return knownVoice;
}

module.exports = { createKnownVoice };
