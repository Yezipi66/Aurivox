// broker 的黑盒集成测试（node:test）：起真实的 server.js，接一个假引擎，
// 然后只从公开的 HTTP 接口这一侧验证行为。
// 后端跑不起来时（依赖没装、服务没就绪）每条用例都带着原因跳过，而不是判失败，
// 所以缺运行环境的机器不会把这套测试跑红。

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startBroker, httpJson, runtimeSkipReason } = require("./__testsupport__/brokerHarness");

let broker = null;
let skipReason = runtimeSkipReason();

before(async () => {
  if (skipReason) return; // 运行时缺失：broker 留 null，各用例自行跳过
  try {
    broker = await startBroker();
  } catch (e) {
    skipReason = e.message; // 启动失败或超时：带上服务日志的末尾
  }
}, { timeout: 90000 });

after(async () => {
  if (broker) await broker.stop();
});

// 守卫：broker 不可用时返回 true，调用方据此跳过这条用例。
function guard(t) {
  if (!broker) { t.skip(skipReason || "broker unavailable"); return true; }
  return false;
}

// 把假引擎复位到健康状态。假引擎在进程内，所以任何一条用例都能调用它。
function resetEngine() {
  if (broker) { broker.engine.state.online = true; broker.engine.state.ttsStatus = 200; }
}

const ci = (headers) => headers; // node 已经把响应头名转成小写
const errMsg = (body) => {
  if (body && typeof body === "object") {
    const err = body.error !== undefined ? body.error : body;
    return String(err && typeof err === "object" ? (err.message ?? JSON.stringify(err)) : err);
  }
  return String(body);
};

// 健康信息聚合（/api/health）：守的是「引擎地址不能写死」
test("health: shape is complete and gpt_sovits_url echoes the CONFIGURED engine URL", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/health");
  assert.equal(status, 200);
  assert.equal(typeof body, "object");
  for (const key of ["ok", "engine_online", "gpt_sovits_url", "ffmpeg_available", "cuda", "deprecated"]) {
    assert.ok(key in body, `missing aggregated health field: ${key}`);
  }
  assert.equal(body.ok, true);
  // 退役公告必须在：两个老字段的迁移清单
  assert.ok(Array.isArray(body.deprecated) && body.deprecated.length === 2,
    'deprecated announcement must list retired fields');
  // 核心回归守卫：报出的引擎地址等于配置的地址，不等于写死的端口。
  assert.equal(
    String(body.gpt_sovits_url).replace(/\/+$/, ""),
    broker.engine.url.replace(/\/+$/, ""),
  );
});

test("health: engine_online is true when the stub is up", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.online = true;
  const { status, body } = await httpJson(broker.base_url + "/api/health");
  assert.equal(status, 200);
  assert.equal(body.engine_online, true);
});

test("health: engine_online flips to false when the stub is down (still 200 ok:true)", async (t) => {
  if (guard(t)) return;
  broker.engine.state.online = false;
  const { status, body } = await httpJson(broker.base_url + "/api/health");
  assert.equal(status, 200);        // 始终不是 500
  assert.equal(body.ok, true);
  assert.equal(body.engine_online, false);
  resetEngine();
});

// 语言防线（/v1/audio/speech）
const speech = (body) => httpJson(broker.base_url + "/v1/audio/speech", { method: "POST", body });

//  契约 §12 第 2 步之后，裸音色名（"jp_voice" 这种，不是 "role/name" 配方）
//  必须自带 engine_id，缺了是 400。所以下面每条走整音色路径的用例都显式写了
//  `engine_id: "gpt-sovits"`（靶场把 GPT_SOVITS_BASE_URL 指向假引擎，见
//  __testsupport__/brokerHarness.js 的 startBroker()）。
//
//  为什么不在 speech() 这个助手里默认塞一个：那样只要改一行，但会把契约
//  藏起来。后来人读这个文件会以为裸音色名照样能直接调，而真实调用方（走
//  OpenAI 兼容口的外部程序）必须自己写这个字段。测试的读者也是它的用户。
//
//  下面四条故意不带 engine_id，因为它们测的是更早的关卡：
//  缺 voice / 缺 input / input 过长（lib/routes/synthesis.js 的 speechService，在音色解析之前），
//  以及 unknown voice 的 404（engine_id 检查故意排在这个 404 之后）。
//  它们不带也该过：这一点由 lib/routes/synthesis.engineRequired.node.test.js 里那三条
//  「不被 engine_id 抢先」加两条「拼错的音色名仍是 404」在打桩环境里钉住。

test("speech: missing 'voice' is 400", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await speech({ input: "hello" });
  assert.equal(status, 400);
  assert.match(errMsg(body).toLowerCase(), /voice/);
});

test("speech: missing 'input' is 400", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await speech({ voice: "jp_voice" });
  assert.equal(status, 400);
  assert.match(errMsg(body).toLowerCase(), /input/);
});

test("speech: oversized input (>5000 chars) is 400", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status } = await speech({ voice: "jp_voice", input: "x".repeat(5001) });
  assert.equal(status, 400);
});

test("speech: unknown voice is 404", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status } = await speech({ voice: "does_not_exist", input: "hi" });
  assert.equal(status, 404);
});

test("speech: language-less voice -> text_lang=auto AND an X-Language-Warning header", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "novoice_lang", input: "hello", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "auto");
  assert.ok(h["x-language-warning"], "missing X-Language-Warning for a language-less voice");
});

test("speech: language-pinned voice -> deterministic X-Text-Lang=ja and NO warning", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "ja");
  assert.ok(!("x-language-warning" in h), "unexpected X-Language-Warning on a pinned-language voice");
});

// Aurivox 扩展：请求可带 language，取值优先级是 请求 > 配方 > 资产

test("speech: request language OVERRIDES a pinned voice language (jp_voice + en -> X-Text-Lang=en, no warning)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "en", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "en", "explicit request language must win over the recipe/asset pin");
  assert.ok(!("x-language-warning" in h), "explicit supported language must NOT warn");
});

test("speech: bare request language normalizes to the engine mode (novoice_lang + zh -> all_zh, no warning)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "novoice_lang", input: "hello", language: "zh", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "all_zh", "bare 'zh' must normalize to the engine's 'all_zh' mode");
  assert.ok(!("x-language-warning" in h), "an explicit request language means the auto-fallback warning must not fire");
});

test("speech: canonical request language passes through unchanged (all_ja -> all_ja, no warning)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  // 配方卡片里那条 curl 在 recipe.language === "all_ja" 时发的就是这个。
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "all_ja", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "all_ja", "canonical 'all_ja' must be accepted verbatim, not treated as unsupported");
  assert.ok(!("x-language-warning" in h), "a valid canonical language must NOT warn");
});

test("speech: request language is case-insensitive (JA -> all_ja)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "JA", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  assert.equal(ci(headers)["x-text-lang"], "all_ja");
});

test("speech: UNSUPPORTED request language falls back to auto AND warns (not a 400)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "fr", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `unsupported language must degrade, not fail; got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "auto", "unsupported language must fall back to auto");
  assert.ok(h["x-language-warning"], "unsupported language must surface an X-Language-Warning");
  assert.match(String(h["x-language-warning"]).toLowerCase(), /not supported/);
});

// 下游验证：请求真的到了 GPT-SoVITS 的 /tts 端点。
// 假引擎会记录 broker POST 给 /tts 的那份 JSON 请求体，所以这些用例不只声称，
// 而是证明请求里的 language 到了推理侧就是一个真正的引擎 text_lang，走的是
// recipe.language 走的同一条 buildTtsPayload 到 /tts 的通路。

test("downstream: bare request language reaches /tts normalized (ja -> text_lang=all_ja)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.lastTts = null;
  const { status } = await speech({ voice: "jp_voice", input: "こんにちは", language: "ja", engine_id: "gpt-sovits" });
  assert.equal(status, 200, `expected 200, got ${status}`);
  const p = broker.engine.state.lastTts;
  assert.ok(p, "the engine received no /tts payload");
  // 把实际发给推理侧的请求体打印出来（在测试输出里可见）：
  console.log("[downstream /tts payload]\n" + JSON.stringify({
    text: p.text, text_lang: p.text_lang, prompt_lang: p.prompt_lang,
    ref_audio_path: p.ref_audio_path, speed_factor: p.speed_factor, media_type: p.media_type,
  }, null, 2));
  assert.equal(p.text_lang, "all_ja", "bare 'ja' must arrive at /tts normalized to the engine mode 'all_ja'");
  assert.equal(p.text, "こんにちは", "the input text must reach the engine unchanged");
});

test("downstream: canonical request language passes through to /tts verbatim (all_ja -> all_ja)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.lastTts = null;
  const { status } = await speech({ voice: "jp_voice", input: "hi", language: "all_ja", engine_id: "gpt-sovits" });
  assert.equal(status, 200);
  assert.equal(broker.engine.state.lastTts.text_lang, "all_ja");
});

test("downstream: unsupported request language degrades to auto at /tts (fr -> text_lang=auto)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.lastTts = null;
  const { status, headers } = await speech({ voice: "jp_voice", input: "hi", language: "fr", engine_id: "gpt-sovits" });
  assert.equal(status, 200);
  assert.equal(broker.engine.state.lastTts.text_lang, "auto", "unsupported language must reach /tts as 'auto'");
  assert.ok(ci(headers)["x-language-warning"], "and still warn the caller");
});

// 训练的续跑与分叉校验（/api/train/start）
const trainStart = (body) => httpJson(broker.base_url + "/api/train/start", { method: "POST", body });
const codeOf = (body) => (body && typeof body === "object" ? body.code : undefined);

test("train/start: missing displayName is 400", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await trainStart({ language: "ja" });
  assert.equal(status, 400);
  assert.match(errMsg(body).toLowerCase().replace(/'/g, ""), /displayname/);
});

test("train/start: missing language is 400", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await trainStart({ displayName: "Test Voice", inputDir: "/tmp/does_not_matter" });
  assert.equal(status, 400);
  assert.match(errMsg(body).toLowerCase(), /language/);
});

test("train/start: resume without inputDir -> 400 INPUT_DIR_REQUIRED", async (t) => {
  if (guard(t)) return;
  resetEngine();
  // 默认步骤下续跑从 'slice' 开始，而那一步需要原始输入目录，
  // 所以不给 inputDir 必须被 INPUT_DIR_REQUIRED 拒掉。
  const { status, body } = await trainStart({ resumeTaskId: "no_such_task", language: "ja" });
  assert.equal(status, 400);
  assert.equal(codeOf(body), "INPUT_DIR_REQUIRED");
});

test("train/start: resume of unknown task (slice disabled) -> 400 RESUME_NO_VOICEID", async (t) => {
  if (guard(t)) return;
  resetEngine();
  // 关掉切片后，续跑越过了 inputDir 这道关，接着因为源任务没有存过音色 id 而失败。
  const { status, body } = await trainStart({
    resumeTaskId: "no_such_task",
    language: "ja",
    steps: { slice: false },
  });
  assert.equal(status, 400);
  assert.equal(codeOf(body), "RESUME_NO_VOICEID");
});
