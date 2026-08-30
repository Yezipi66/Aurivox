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
const { checkpointStatus } = require("../engines/checkpoints");

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
    // ⛔ 这里原本有 hot_swap_models —— 2026-08-30 随名片一起退休，不再吐给界面。
    //   「能不能换一份模型」逐位回答，答案在下面的 weight_slots[].applies_at 里。
    streaming: profile.streaming,
    supports_finetune: profile.supports_finetune,
    // 界面长面板那份格子定义。空数组 = 这张名片没写 params.schema，
    // 不代表这台引擎没有参数（它的 param_keys 可能是满的）。
    param_schema: profile.param_schema,
    param_keys: profile.param_keys,
    // ⭐⭐ 这台引擎有几个模型位、每个位叫什么。名片的 weights 段解析而来。
    //
    //   界面靠它回答「模型那一排该长出几个下拉、每个下拉标什么」。在这一行
    //   之前，界面上写死的是两个（GPT / SoVITS）—— 那是**一台引擎的形状**，
    //   于是只有一个模型位的引擎在界面上永远是两个下拉里的一个空壳。
    //
    // ⛔ 这里不许兜底成「没写就当成 2 个」：名片漏写 weights 的正确表现是
    //   「一个模型下拉都不长」，那是作者一眼看得见的；替他猜一个数字会让
    //   下拉里出现装不进去的候选，而那不报错。
    //
    // ⚠ 位的**个数**跟「换它要走哪一步」是两件事：前者说这台引擎有几份权重，
    //   后者（每个位自己的 applies_at）只说换的时候要不要把进程重开一次。
    //   ⛔ 拿后者决定前者显不显示，等于用「怎么装载它」定义「它存不存在」。
    weight_slots: profile.weight_slots,
    // ⭐ 这台引擎给**平台的词**准备了映射的那些键 —— 只吐键名，不吐映射到
    //   什么（映射到哪个引擎原生键是拼请求体的事，界面不该知道）。
    //
    //   界面靠它回答一个问题：**这一格该不该长出来**。参考转写、语种、
    //   辅助参考音频这些不是引擎参数（不在 param_schema 里），是平台自己
    //   的概念，只有名片给它铺了路才发得出去。真机实据：盘上两台一台铺了
    //   10 条、一台只铺了 4 条 —— 后者没有 aux_reference_audio，界面上却照样
    //   画着一个辅助参考音频选择器，选完发不出去，没有任何提示。
    //
    // ⛔ 不在这里判「支不支持某某功能」再吐一堆布尔 —— 那等于把平台的词
    //   一个一个抄进代码，加一个词就要改这里。吐名单，谁要问谁自己查。
    mapped_keys: Object.keys(profile.maps || {}),
    // ⭐ 2026-08-29：底模在哪、齐不齐。
    //   Owner 原话「你都读不到底模在哪里」—— 在这一行之前，这个接口确实
    //   一个字节的底模信息都不回，界面想显示也没东西可显示。
    //   ⚠ 这一段**要读盘**（其余字段都是纯搬运），所以它是唯一一处
    //     describeEngine 里带 I/O 的地方。代价是几次 statSync，
    //     ⛔ 不值得为它再开一个接口 —— 分开之后界面就得发两个请求，
    //       而这两件事永远是一起要的。
    checkpoints: checkpointStatus(profile),
  };
}

module.exports = function createRouter(ctx) {
  const router = express.Router();
  // ⚠ 可能没有（老部署、测试夹具）。⛔ 缺了就当"这台机器不管进程"，
  //   不抛 —— 接线缺失不该表现成「引擎列表打不开」。
  const supervisor = (ctx && ctx.engineSupervisor) || null;

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

    // ⭐⭐ 进程侧的实况：这台引擎此刻**在不在跑**、装的是**哪一份**模型、
    //   是不是正在起来的路上。⛔ 这跟上面那个 online 不是一回事：
    //     online   = 探活能不能打通（一台别人手工起的引擎也会是 true）
    //     process  = **这个平台**起没起过它
    //   合并成一个字段的话，"引擎在跑但不是我起的"就没法表达了，而那正是
    //   开发机上最常见的一种状态。
    //   null = 这台机器不管进程（没装看管人）—— ⛔ 不是「没在跑」。
    const procStatus = supervisor ? supervisor.status() : null;
    for (const e of engines) {
      e.process = procStatus ? (procStatus[e.id] || { running: false }) : null;
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
