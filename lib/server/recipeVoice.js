// Recipe role validation: checks whether a voice id is a base voice or exists in the store.

function createKnownVoice(isBaseVoice, loadVoices) {
  function knownVoice(role) {
    if (isBaseVoice(role)) return true;
    try { return Object.prototype.hasOwnProperty.call(loadVoices(), role); }
    catch (_) { return false; }
  }
  return knownVoice;
}

module.exports = { createKnownVoice };
