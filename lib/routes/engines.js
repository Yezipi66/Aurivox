// ===========================
//  ROUTES: Engines (装了哪几台、各自什么形状、活着没有)
// ===========================
// 契约 §12 第 2 步：调用方要能说出「这一次用哪台引擎」，前提是它先问得到
// 「这台机器上装了哪几台、各自叫什么、参数长什么样」。
//
// ⭐ 这个文件出现之前，registry.listEngines() 全仓唯一的消费者是画布
//   （lib/flowgraph/service.js）—— 也就是说后端自己没有任何一处能回答这个
//   问题。少了它，「必须带 engine_id」就成了一句没法照办的要求。
//
// ⛔ 本文件里不允许出现任何具体引擎的名字（同 lib/engines/registry.js 的规矩，
//    那里有守卫测试盯着）。探活地址、参数表、时长窗口、上限字数，全部问名片要。
//    真机实据：两台引擎的 runtime.ready_endpoint 分别是 "/" 和 "/health" ——
//    在这里写死任何一个，另一台就会永远显示离线。

const express = require("express");
const { listEngines } = require("../engines/registry");
const { resolveEngineProfile } = require("../engines/profile");

// 探活超时。
// ⛔ 不能拿名片的 runtime.ready_timeout_ms 来当这个值 —— 那个回答的是
//   「等它冷启动要等多久」（真机上是几十秒到几分钟），这里问的是
//   「它现在答不答话」。两个问题混用，会让这个列表接口挂住几分钟。
const PROBE_TIMEOUT_MS = 2000;

// 「同时开几台」这句提醒是**平台**说的，不是名片说的。
// ⛔ 故意不带任何数字：每台占多少内存随模型、随精度、随并发浮动，
//   把一个数写进名片或代码，就是又一处早晚会过期的死数据。
const CONCURRENCY_NOTICE =
  "同时启动多台引擎会占用大量内存，是否同时开请自行判断 OOM 风险。";

// 探一台引擎现在活没活。
// 导出是为了让 /api/health 的逐台健康（同一步的另一处改动）复用同一份实现 ——
// 两处各写一遍探活，迟早会在超时值或判定条件上分叉。
async function probeEngineOnline(profile, timeoutMs = PROBE_TIMEOUT_MS) {
  const endpoint = profile.runtime && profile.runtime.ready_endpoint;
  if (!endpoint) {
    // 名片没有 runtime 段 = 这台引擎不由平台启动（契约认这是合法的）。
    // 那平台也就不知道该访问哪个地址判断它活没活。
    // ⛔ 这里必须是 null，不能是 false ——「不知道」和「确定不在线」是两件
    //   事，糊成同一个假值之后，界面上那个灰点就再也说不清是哪一种了。
    return { online: null, reason: "manifest.json 里没有 runtime.ready_endpoint，无法确认这台引擎是否在运行" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${profile.base_url}${endpoint}`, { signal: ctrl.signal });
    return { online: r.ok, reason: r.ok ? null : `HTTP ${r.status}` };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError");
    return {
      online: false,
      reason: aborted ? `超过 ${timeoutMs}ms 没有响应` : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 名片 → 对外的形状。
// ⚠ 这里只**搬运** profile 已经解析好的字段，不做任何二次判断：一旦在这里
//   补一句「没写就当成 xxx」，名片漏写就会变成静默默认值，而那正是契约要
//   消灭的东西。
function describeEngine(profile) {
  return {
    id: profile.id,
    label: profile.label,
    // 由平台启动 = 名片写了 runtime 段。没写不是错，是「这台你自己起」。
    managed: profile.runtime !== null,
    // 两个地址回答两个不同的问题，都吐出去：
    //   base_url          合成请求发到哪儿（会被名片声明的 env 顶掉）
    //   default_base_url  这台引擎自己该监听哪儿（env 顶不动）
    base_url: profile.base_url,
    base_url_source: profile.base_url_source,
    default_base_url: profile.default_base_url,
    requires_reference_audio: profile.requires_reference_audio,
    // null = 名片明确声明「不限制」，不是「忘了写」（忘写在 profile 层就抛了）。
    reference_clip_seconds: profile.reference_clip_seconds,
    max_chars: profile.max_chars,
    hard_max_chars: profile.hard_max_chars,
    output_sample_rate: profile.output_sample_rate,
    hot_swap_models: profile.hot_swap_models,
    streaming: profile.streaming,
    supports_finetune: profile.supports_finetune,
    // 界面长面板那份格子定义。空数组 = 这张名片没写 params.schema，
    // 不代表这台引擎没有参数（它的 param_keys 可能是满的）。
    param_schema: profile.param_schema,
    param_keys: profile.param_keys,
  };
}

module.exports = function createRouter(_ctx) {
  const router = express.Router();

  router.get("/api/engines", async (req, res) => {
    let manifests;
    try {
      manifests = listEngines();
    } catch (err) {
      // 扫目录这一层挂了是真的挂了（比如某张 manifest.json 语法错误），
      // 不能装作「一台引擎都没装」—— 那会让一个逗号写错表现为引擎集体消失。
      return res.status(500).json({
        ok: false,
        error: `列举引擎失败：${(err && err.message) || err}`,
        code: (err && err.code) || null,
      });
    }

    // 名片坏掉的引擎单独归到 errors，不让它带塌整个列表：一台引擎少写一个
    // 必填键，不应该表现为「所有引擎都不见了」。
    // ⛔ 也不能静默跳过 —— profile.js 里那处 `schema === undefined 就 return []`
    //   的静默降级已经教过一次：看着正常、实际什么都没有，最难查。
    const resolved = [];
    const errors = [];
    for (const m of manifests) {
      try {
        resolved.push(resolveEngineProfile(m.id));
      } catch (err) {
        errors.push({
          id: m.id,
          code: (err && err.code) || null,
          error: (err && err.message) || String(err),
        });
      }
    }

    const engines = resolved.map(describeEngine);

    // probe=0：只列不探。探活要打网络，而「画一次列表」不该被一台超时的
    // 引擎拖住 —— 调用方只想知道装了哪几台时，给它一条不打网络的路。
    const probe = String(req.query.probe == null ? "1" : req.query.probe) !== "0";
    if (probe) {
      // 并行。串行的话总耗时是各台超时之和，装 5 台就是 10 秒。
      const results = await Promise.all(resolved.map((p) => probeEngineOnline(p)));
      results.forEach((r, i) => {
        engines[i].online = r.online;
      });
    } else {
      // probe=0 ⇒ online 是 null。三态里的 null 本身就是「没查过」，
      // ⛔ 不再另发一句 online_reason 解释它（Owner 裁决：那句话写不出人话，
      //    而且 /api/health 那边早就去掉了 —— 同一个决策两处接口得同形状）。
      for (const e of engines) {
        e.online = null;
      }
    }

    res.json({ ok: true, engines, errors, notice: CONCURRENCY_NOTICE });
  });

  return router;
};

// 供 /api/health 的逐台健康复用（同一步的另一处改动），以及测试直接调。
module.exports.probeEngineOnline = probeEngineOnline;
module.exports.describeEngine = describeEngine;
module.exports.CONCURRENCY_NOTICE = CONCURRENCY_NOTICE;
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
