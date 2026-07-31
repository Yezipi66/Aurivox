// ===========================
//  MODEL SWITCH STATE (same-model request coalescing)
// ===========================
// The local GPT-SoVITS engine holds exactly ONE (GPT, SoVITS) weight pair in
// memory at a time. Before every synthesis the Broker calls /set_gpt_weights
// and /set_sovits_weights (see switchModels in server.js). Those calls are
// expensive — the engine reloads and re-initialises the checkpoint — and are
// pure waste when the *next* request wants the SAME weights that are already
// resident (the common case: a batch / many segments / repeated calls for one
// voice).
//
// ModelSwitcher remembers the LAST SUCCESSFULLY loaded gpt/sovits paths and
// skips the redundant HTTP round-trip when the requested path is identical.
// This is "same-model request coalescing": correctness is unchanged (the same
// weights are resident), only the redundant reload is elided.
//
// Concurrency: all synthesis runs under a single global generation mutex
// (withGenerationLock), so ensure() is only ever entered by one request at a
// time. This class therefore needs no internal locking — the invariant it
// relies on (its cache mirrors the engine's resident weights) can only be
// mutated serially.
//
// Failure handling: if a set_*_weights call fails, the engine's resident state
// is now UNKNOWN, so the corresponding cache slot is cleared to force a real
// switch on the next attempt (never skip after a failure). Callers that detect
// the engine may have restarted (losing all resident weights) can call reset()
// to invalidate the whole cache.

class ModelSwitcher {
  // gsvGet: async (pathStr, params) => { statusCode, body } — same shape as
  // lib/gsv/client.js gsvGet, injected so this module stays stdlib-only and
  // is unit-testable without a live engine.
  constructor(gsvGet) {
    if (typeof gsvGet !== "function") {
      throw new TypeError("ModelSwitcher requires a gsvGet(pathStr, params) function");
    }
    this._gsvGet = gsvGet;
    this._loadedGpt = null;    // last successfully loaded GPT weights_path
    this._loadedSovits = null; // last successfully loaded SoVITS weights_path
  }

  // Forget the cached resident weights (e.g. after an engine restart). The next
  // ensure() will unconditionally re-issue both switches.
  reset() {
    this._loadedGpt = null;
    this._loadedSovits = null;
  }

  // Currently-believed resident weights (mainly for observability / tests).
  get loaded() {
    return { gpt: this._loadedGpt, sovits: this._loadedSovits };
  }

  // Ensure the engine has cfg.gpt_model / cfg.sovits_model resident, switching
  // only when the requested path differs from what is already loaded. A falsy
  // model field means "caller does not pin this weight" — leave whatever is
  // resident untouched (identical to the pre-coalescing behaviour).
  //
  // Returns { switchedGpt, switchedSovits, skippedGpt, skippedSovits } so the
  // caller / tests can observe when a redundant reload was elided. Throws on a
  // failed switch (same Error messages as the original switchModels), after
  // invalidating the affected cache slot.
  async ensure(cfg) {
    cfg = cfg || {};
    const result = { switchedGpt: false, switchedSovits: false, skippedGpt: false, skippedSovits: false };

    if (cfg.gpt_model) {
      if (cfg.gpt_model === this._loadedGpt) {
        result.skippedGpt = true;
      } else {
        const r = await this._gsvGet("/set_gpt_weights", { weights_path: cfg.gpt_model });
        if (r.statusCode >= 400) {
          this._loadedGpt = null; // resident state now unknown
          const msg = r.body ? r.body.toString() : "";
          console.error("set_gpt_weights failed:", msg);
          throw new Error(`set_gpt_weights failed (${r.statusCode}): ${msg}`);
        }
        this._loadedGpt = cfg.gpt_model;
        result.switchedGpt = true;
      }
    }

    if (cfg.sovits_model) {
      if (cfg.sovits_model === this._loadedSovits) {
        result.skippedSovits = true;
      } else {
        const r = await this._gsvGet("/set_sovits_weights", { weights_path: cfg.sovits_model });
        if (r.statusCode >= 400) {
          this._loadedSovits = null; // resident state now unknown
          const msg = r.body ? r.body.toString() : "";
          console.error("set_sovits_weights failed:", msg);
          throw new Error(`set_sovits_weights failed (${r.statusCode}): ${msg}`);
        }
        this._loadedSovits = cfg.sovits_model;
        result.switchedSovits = true;
      }
    }

    return result;
  }
}

module.exports = { ModelSwitcher };
