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
    // ⭐⭐⭐ 一台引擎一格。过去这里是两个标量（_loadedGpt/_loadedSovits），
    //   也就是**全平台共用一份「引擎现在装着什么」**。装第二台引擎之后那份
    //   记录就是错的：A 上装过 x.ckpt ⇒ 给 B 的这一次会命中"已经装了"而
    //   跳过换权重 ⇒ B 用着它自己上一次的权重出声，**不报错，只是声音不对**。
    //   缓存的作用域必须和它描述的那个事实的作用域一样大 —— 那个事实是
    //   「**那台**引擎的显存里现在坐着谁」。
    this._resident = new Map(); // engineKey -> { gpt, sovits }
    this._engineOnlineLast = null; // null=unprobed, true/false once /api/health reports
  }

  // 谁的显存 —— 地址就是身份（同一个 id 换了地址就是另一台进程）。
  // 不带引擎的老调用方共用 "" 这一格，行为与从前逐字相同。
  _key(engine) {
    if (!engine) return "";
    return String(engine.base_url || engine.id || "");
  }

  _slot(key) {
    let slot = this._resident.get(key);
    if (!slot) { slot = { gpt: null, sovits: null }; this._resident.set(key, slot); }
    return slot;
  }

  // Forget the cached resident weights (e.g. after an engine restart). The next
  // ensure() will unconditionally re-issue both switches.
  //
  // ⚠ 清的是**所有**引擎那一格。健康探测今天只报一个总的在线/不在线，说不出
  //   是哪一台重启了；多清几格的代价是多换一次权重（慢），少清一格的代价是
  //   用错权重出声（不报错）。两者不对称，所以往多了清。
  reset() {
    this._resident.clear();
  }

  // Feed engine liveness (from the /api/health probe) so a restart invalidates
  // the cache. When the engine goes offline and later comes back, its resident
  // GPT/SoVITS weights are gone — but our cache still points at them, so the
  // next ensure() would false-skip the switch and synthesise with the wrong (or
  // no) model. On an offline->online transition we therefore reset(). This is
  // the exact scenario triggered when a user moves the project to another
  // machine/path: start.ps1's Repair-EngineConfig rebuilds tts_infer.yaml back
  // to base models and the engine reboots without the previously-selected voice.
  //
  // Only a genuine false->true flip triggers a reset. The first probe (unknown
  // -> anything) and steady-state (true->true / false->false) never do. Returns
  // true iff this call invalidated the cache (for tests / observability).
  noteEngineHealth(online) {
    const wasOffline = this._engineOnlineLast === false;
    this._engineOnlineLast = !!online;
    if (online && wasOffline) {
      this.reset();
      return true;
    }
    return false;
  }

  // Currently-believed resident weights (mainly for observability / tests).
  // 不带参数 = 不带引擎的那一格（老调用方），与从前含义相同。
  get loaded() {
    return this.loadedFor(null);
  }

  // 某一台引擎那一格。
  loadedFor(engine) {
    const slot = this._resident.get(this._key(engine));
    return slot ? { gpt: slot.gpt, sovits: slot.sovits } : { gpt: null, sovits: null };
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
  // `engine` = 已解析的名片对象（要用到的只有 base_url / timeout_ms / id）。
  // ⭐ 换权重是**发给某一台引擎的请求**，所以它必须知道发到哪儿。过去这两句
  //   调的是不带地址的 gsvGet ⇒ 客户端当场抛 ENGINE_BASE_URL_MISSING
  //   （lib/gsv/client.js:47），前端看到的是 "Internal server error"。
  // ⛔ 这里不替调用方挑一台：不给地址就让客户端照旧抛，理由与那一刀相同。
  async ensure(cfg, engine = null) {
    cfg = cfg || {};
    const result = { switchedGpt: false, switchedSovits: false, skippedGpt: false, skippedSovits: false };
    const slot = this._slot(this._key(engine));
    const opts = engine ? { baseUrl: engine.base_url, reqTimeout: engine.timeout_ms } : undefined;

    if (cfg.gpt_model) {
      if (cfg.gpt_model === slot.gpt) {
        result.skippedGpt = true;
      } else {
        const r = await this._gsvGet("/set_gpt_weights", { weights_path: cfg.gpt_model }, opts);
        if (r.statusCode >= 400) {
          slot.gpt = null; // resident state now unknown
          const msg = r.body ? r.body.toString() : "";
          console.error("set_gpt_weights failed:", msg);
          throw new Error(`set_gpt_weights failed (${r.statusCode}): ${msg}`);
        }
        slot.gpt = cfg.gpt_model;
        result.switchedGpt = true;
      }
    }

    if (cfg.sovits_model) {
      if (cfg.sovits_model === slot.sovits) {
        result.skippedSovits = true;
      } else {
        const r = await this._gsvGet("/set_sovits_weights", { weights_path: cfg.sovits_model }, opts);
        if (r.statusCode >= 400) {
          slot.sovits = null; // resident state now unknown
          const msg = r.body ? r.body.toString() : "";
          console.error("set_sovits_weights failed:", msg);
          throw new Error(`set_sovits_weights failed (${r.statusCode}): ${msg}`);
        }
        slot.sovits = cfg.sovits_model;
        result.switchedSovits = true;
      }
    }

    return result;
  }
}

module.exports = { ModelSwitcher };
