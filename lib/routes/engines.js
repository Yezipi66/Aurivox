// 引擎列表与起停路由（契约 §12）。调用方要能说出「这一次用哪台引擎」，前提是它先问得到
// 「本机上装了哪几台、各自叫什么、参数长什么样」：探活地址、参数表、时长窗口与上限字数
// 全部取自名片，写死其中任何一项，另一台引擎就会永远显示离线。
// 起停与合成共用同一把全局锁，并走与 /api/fs/mkdir 同一道鉴权门。
// 是否可以启动（名额、内存、忙碌、是否需要重开）由 residency.js 与 supervisor 判断。
// 不写具体引擎名（有守卫测试）。

const express = require("express");
const { listEngines } = require("../engines/registry");
const { resolveEngineProfile } = require("../engines/profile");
const { checkpointStatus } = require("../engines/checkpoints");

// 探活超时。不能拿名片的 runtime.ready_timeout_ms 来当这个值：那个回答的是
// 「等它冷启动要等多久」（几十秒到几分钟），这里问的是「它现在答不答话」。
const PROBE_TIMEOUT_MS = 2000;

// 这句提醒由平台给出，不来自名片，因此不带任何数字：每台占多少内存随模型、精度与并发浮动。
const CONCURRENCY_NOTICE =
 "同时启动多台引擎会占用大量内存，是否同时开请自行判断 OOM 风险。";

// 探一台引擎现在活没活。导出是为了让 /api/health 的逐台健康复用同一份实现：两处各写一遍探活迟早会分叉。
async function probeEngineOnline(profile, timeoutMs = PROBE_TIMEOUT_MS) {
 const endpoint = profile.runtime && profile.runtime.ready_endpoint;
 if (!endpoint) {
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

// 名片 → 对外的形状。这里只搬运 profile 已经解析好的字段：补一句「没写就当成 xxx」
// 就会让名片漏写变成静默默认值。
function describeEngine(profile) {
 return {
 id: profile.id,
 label: profile.label,
 managed: profile.runtime !== null,
    // 两个地址回答两个不同的问题：base_url 是合成请求发到哪儿（会被名片声明的 env 顶掉），
    // default_base_url 是它该监听哪儿（env 顶不动）。
 base_url: profile.base_url,
 base_url_source: profile.base_url_source,
 default_base_url: profile.default_base_url,
 requires_reference_audio: profile.requires_reference_audio,
 reference_clip_seconds: profile.reference_clip_seconds,
 max_chars: profile.max_chars,
 hard_max_chars: profile.hard_max_chars,
 output_sample_rate: profile.output_sample_rate,
 streaming: profile.streaming,
 supports_finetune: profile.supports_finetune,
 param_schema: profile.param_schema,
 param_keys: profile.param_keys,
    // 这次走哪个推理方法。界面靠这两个字段画一个下拉，交的是名字列表，不是 call.methods
    // 那个对象：前端碰它就成了第二份「方法有哪些」的事实。
 methods: profile.methods,
 default_method: profile.default_method,
    // 这台引擎有几个模型位、每个位叫什么。界面靠它回答「模型那一排该长出几个下拉」。
    // 这里不兜底成「没写就当成 2 个」：替他猜一个数字会让下拉里出现装不进去的候选。
 weight_slots: profile.weight_slots,
    // 这台引擎给平台的词准备了映射的那些键：只吐键名，不吐映射到
    // 什么（映射到哪个引擎原生键是拼请求体的事，界面不该知道）。
    // 界面靠它回答一个问题：这一格该不该长出来。参考转写、语种、辅助参考音频这些
    // 不是引擎参数（不在 param_schema 里），是平台自己的概念，只有名片给它铺了路
    // 才发得出去：一台铺了 10 条、一台只铺了 4 条时，后者界面上照样画着选择器。
 mapped_keys: Object.keys(profile.maps || {}),
 checkpoints: checkpointStatus(profile),
 };
}

module.exports = function createRouter(ctx) {
 const router = express.Router();
 const supervisor = (ctx && ctx.engineSupervisor) || null;

 router.get("/api/engines", async (req, res) => {
 let manifests;
 try {
 manifests = listEngines();
 } catch (err) {
    // 扫目录这一层挂了是真的挂了（比如某张 manifest.json 语法错误），不能装作「一台引擎都没装」。
 return res.status(500).json({
 ok: false,
 error: `列举引擎失败：${(err && err.message) || err}`,
 code: (err && err.code) || null,
 });
 }

    // 名片坏掉的引擎单独归到 errors，不让它带塌整个列表：一台引擎少写一个必填键，
    // 不应该表现为「所有引擎都不见了」。也不能静默跳过：看着正常、实际什么都没有。
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

 const probe = String(req.query.probe == null ? "1" : req.query.probe) !== "0";
 if (probe) {
 const results = await Promise.all(resolved.map((p) => probeEngineOnline(p)));
 results.forEach((r, i) => {
 engines[i].online = r.online;
 });
 } else {
    // probe=0 ⇒ online 是 null。三态里的 null 本身就是「没查过」，不再另发一句解释它。
 for (const e of engines) {
 e.online = null;
 }
 }

    // 进程侧的实况：此刻是否在运行、加载的是哪一份模型、是不是正在起来的路上。
    // 这跟上面那个 online 不是一回事：online = 探活能不能打通（一台别人手工起的
    // 引擎也会是 true），process = 这个平台起没起过它。
    // null = 本机不管进程（未装看管人）：不是「未运行」。
 const procStatus = supervisor ? supervisor.status() : null;
 for (const e of engines) {
 e.process = procStatus ? (procStatus[e.id] || { running: false }) : null;
 }

    // occupancy 回答「平台此刻占了你的什么」。放进这个接口而不是新开一个：分两个口 = 两次请求 = 两次之间状态可能已经变了。
 let occupancy = null
 if (supervisor && typeof supervisor.occupancy === 'function') {
 try {
 occupancy = supervisor.occupancy(resolved)
 } catch (err) {
 occupancy = { error: (err && err.message) || String(err) }
 }
 }

 res.json({ ok: true, engines, errors, notice: CONCURRENCY_NOTICE, occupancy });
 });

  // 引擎的写路（起 / 停）。内核做完 ≠ 功能做完，中间还差一个口和一个按钮。
  // 本段不出现任何编排逻辑。判「能不能起」（名额、内存、忙不忙、要不要重开）
  // 全部是 residency.js + supervisor 的活。

  // 起 / 停必须和合成走同一把锁。supervisor.js 的 ensure() 只在 withGenerationLock 里被调用，
  // 这句话靠这里继续为真：不加锁的表现不是报错，是「一边正在合成、另一边把进程重开了」。
 const withLock = (ctx && ctx.withGenerationLock) || null;

 function noWriteRoute(res, what) {
 if (!supervisor) {
 return res.status(501).json({
 ok: false,
 code: "ENGINE_SUPERVISOR_MISSING",
 error: `这台部署没有装引擎看管人，平台${what}不了引擎（引擎由作者自己起）。`,
 });
 }
 if (!withLock) {
 return res.status(501).json({
 ok: false,
 code: "ENGINE_LOCK_MISSING",
 error:
 `这台部署没有把全局合成锁接进引擎路由，为安全起见拒绝${what}引擎：` +
 "不加锁地起停会和正在执行的合成冲突，表现为不完整的音频。",
 });
 }
 return null;
 }

  // ensure()/stop() 抛出来的 code → HTTP 状态码。不许把它们全压成 500：界面要能区分
  // 「换个时间再试」（409）和「这台引擎压根不存在」（404）。
 const STATUS_BY_CODE = {
 ENGINE_UNKNOWN: 404,
 ENGINE_BUSY_OTHER_WEIGHT: 409,
 ENGINE_BUSY: 409,
 ENGINE_NEEDS_CONFIRM: 409,
 ENGINE_NO_MEMORY: 409,
 ENGINE_TOO_MANY_LAUNCH_SLOTS: 400,
 ENGINE_BASE_URL_MISSING: 500,
 };

 function sendEngineError(res, err) {
 const code = (err && err.code) || null;
 const status = STATUS_BY_CODE[code] || 500;
 res.status(status).json({
 ok: false,
 code,
 error: (err && err.message) || String(err),
    // mem 原样透出去。ENGINE_NEEDS_CONFIRM 的文案里故意没有「预计要多少」
    // （我们不知道，编一个数被信了之后账算平台头上），界面要弹框问用户就得拿到 freeMb 自己排版。
 mem: (err && err.mem) || null,
 });
 }

  // 起 / 停要走和别的「会改变机器状态」的接口同一道门（server.js 的 requireApiKey：
  // 本机回环永远放行，远程才要 key）。起一台引擎会吃掉几个 G 的内存、关一台会杀掉一个进程，
  // 跟 /api/fs/mkdir 同级，不该比它更容易从外网够到。
  // 拿不到这道门时不许默默放行：ctx 里没有 requireApiKey 只可能是接线漏了。
 const apiKeyGuard = (req, res, next) => {
 const g = ctx && ctx.requireApiKey;
 if (typeof g !== "function") {
 return res.status(501).json({
 ok: false,
 code: "ENGINE_AUTH_MISSING",
 error: "这台部署没有把鉴权接进引擎路由，为安全起见拒绝起停引擎。",
 });
 }
 return g(req, res, next);
 };

 router.post("/api/engines/:id/start", apiKeyGuard, async (req, res) => {
 const blocked = noWriteRoute(res, "启动");
 if (blocked) return;

 const id = String(req.params.id || "");
 let profile;
 try {
 profile = resolveEngineProfile(id);
 } catch (err) {
    // 名片坏了和引擎不存在是两回事，但对「起不来」来说都是 404 级的「没有这台可用的引擎」。
 return res.status(404).json({
 ok: false,
 code: (err && err.code) || "ENGINE_UNKNOWN",
 error: (err && err.message) || String(err),
 });
 }

 const body = req.body || {};
 const selection = body.weights && typeof body.weights === "object" ? body.weights : {};
    // 「没说」和「说了不同意」必须分开传下去：supervisor.js 靠 undefined 区分这两者。写成 !!body.confirmed 会把「没说」变成「拒绝」。
 const opts = Object.prototype.hasOwnProperty.call(body, "confirmed")
 ? { confirmed: !!body.confirmed }
 : {};

 try {
 const r = await withLock(() => supervisor.ensure(profile, selection, opts));
 res.json({ ok: true, id: profile.id, ...r });
 } catch (err) {
 sendEngineError(res, err);
 }
 });

 router.post("/api/engines/:id/stop", apiKeyGuard, async (req, res) => {
 const blocked = noWriteRoute(res, "关闭");
 if (blocked) return;

 const id = String(req.params.id || "");
 try {
 const stopped = await withLock(() => {
        // 正在执行合成的引擎不许关。锁只挡住「另一次合成」，挡不住「合成正跑到一半而这个请求进来了」：busy 才挡得住。
 const st = supervisor.status()[id];
 if (st && st.busy) {
 const e = new Error(
 `引擎 ${id} 正在执行合成任务，关闭该引擎将导致本次合成得到不完整的音频。请待其执行完成后再关闭。`
 );
 e.code = "ENGINE_BUSY";
 throw e;
 }
        // stop() 幂等：未运行时返回 false。那不是错误，「关一台本来就没开的引擎」应该成功，界面才敢无脑重试。
 return supervisor.stop(id, "从引擎管理页手动关闭");
 });
 res.json({ ok: true, id, stopped });
 } catch (err) {
 sendEngineError(res, err);
 }
 });

 return router;
};

module.exports.probeEngineOnline = probeEngineOnline;
module.exports.describeEngine = describeEngine;
module.exports.CONCURRENCY_NOTICE = CONCURRENCY_NOTICE;
module.exports.PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
