// 同模型请求合并：记住本地引擎显存里当前坐着哪一份 (GPT, SoVITS) 权重。
// 引擎同一时刻只装得下一对权重，每次合成前都要重载检查点；当下一次要的正是已经
// 驻留的那一份时那次重载纯属浪费。合并只省掉多余的往返，权重本身不变。
// 并发前提：所有合成都在同一把全局生成锁下跑，ensure() 同一时刻只有一个请求进得来；
// set_*_weights 失败后驻留状态不可知，对应那一格清空，下次必定真换一次。

class ModelSwitcher {
  // gsvGet: (pathStr, params) => { statusCode, body }，与 lib/gsv/client.js 的 gsvGet
  // 同形；注入进来是为了让本模块只依赖标准库。
  constructor(gsvGet) {
    if (typeof gsvGet !== "function") {
      throw new TypeError("ModelSwitcher requires a gsvGet(pathStr, params) function");
    }
    this._gsvGet = gsvGet;
    // 一台引擎一格，作用域和它描述的事实一样大。
    this._resident = new Map(); // engineKey -> { gpt, sovits }
    this._engineOnlineLast = null; // null=未探测，true/false 是 /api/health 报过的
  }

  // 谁的显存：地址就是身份（同一个 id 换了地址就是另一台进程）。
  _key(engine) {
    if (!engine) return "";
    return String(engine.base_url || engine.id || "");
  }

  _slot(key) {
    let slot = this._resident.get(key);
    if (!slot) { slot = { gpt: null, sovits: null }; this._resident.set(key, slot); }
    return slot;
  }

  // 忘掉缓存的驻留权重（例如引擎重启之后），下一次 ensure() 会无条件重发两次切换。
  // 清的是所有引擎那一格：健康探测只报总的在线/不在线，说不出哪台重启了；多清几格
  // 慢一点，少清一格可能用错权重出声，所以往多了清。
  reset() {
    this._resident.clear();
  }

  // 喂进引擎的存活状态（来自 /api/health 探测），让重启能作废缓存。引擎掉线再上线时
  // 显存里的权重已经没了，缓存仍指着它们，下一次 ensure() 就会用错的模型出声，
  // 因此在 离线→上线 的跳变上 reset()；只有真的 false→true 才重置。
  noteEngineHealth(online) {
    const wasOffline = this._engineOnlineLast === false;
    this._engineOnlineLast = !!online;
    if (online && wasOffline) {
      this.reset();
      return true;
    }
    return false;
  }

  get loaded() {
    return this.loadedFor(null);
  }

  loadedFor(engine) {
    const slot = this._resident.get(this._key(engine));
    return slot ? { gpt: slot.gpt, sovits: slot.sovits } : { gpt: null, sovits: null };
  }

  // 确保引擎显存里是 cfg.gpt_model / cfg.sovits_model，只有要的路径与已经加载的不同
  // 时才真的切。模型字段为假值表示「调用方没钉这一份」，显存里现有的不动。
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
          slot.gpt = null; // 驻留状态已不可知
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
          slot.sovits = null; // 驻留状态已不可知
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
