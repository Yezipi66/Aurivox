// POST /api/generate 的行为测试。
// 用一份全部替身化的 ctx 搭出合成路由（不碰引擎、GPU 与文件系统），截下注册的
// handler，把每一条响应出口都走一遍，断言 HTTP 状态码与响应体形状。
// 覆盖的是「请求进、响应出」的形状：缺字段、超长、引擎报错、分段与拼接的成败。
// 跑法：node --test tools/tests/generate_service.node.test.js
const path = require("path");
const Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..");

const realResolveRefPath = require(path.join(ROOT, 'lib', 'server', 'paths')).resolveRefPath;
const realPathResolver = require(path.join(ROOT, 'lib', 'pathResolver'));


// 替身 express：把注册进来的路由 handler 截下来
const captured = {};
const expressShim = function () { const a = {}; for (const m of ["get","post","put","delete","patch","use","all"]) a[m] = () => a; return a; };
expressShim.Router = function () {
  const r = {};
  for (const m of ["get","put","delete","patch","use","all"]) r[m] = () => r;
  r.post = (p, ...handlers) => { captured[p] = handlers[handlers.length - 1]; return r; };
  return r;
};
expressShim.static = () => (q, s, n) => n && n();
expressShim.json = () => (q, s, n) => n && n();
expressShim.urlencoded = () => (q, s, n) => n && n();
const orig = Module._load;
Module._load = function (request) { if (request === "express") return expressShim; return orig.apply(this, arguments); };

// 替身 ctx
const state = {};
// 假引擎：请求点名了哪台就返回哪台。位表是空的：
// 这个文件测的是「请求 → 响应」的形状，不测模型位的挑选。
const FAKE_ENGINE = {
  id: "test-engine",
  label: "Test Engine",
  base_url: "http://127.0.0.1:1",
  timeout_ms: 60000,
  max_chars: 30,
  requires_reference_audio: true,
  reference_clip_seconds: null,
  hot_swap_models: false,
  param_keys: [],
  maps: { text: "text", reference_audio: "ref_audio_path", seed: "seed", media_type: "media_type" },
  payload_keys: [],
  defaults: {},
  param_schema: [],
  // 给一个位：switchModels 只在「这台引擎有可换的位」时才被调，
  // 位表为空的话那个失败场景根本走不到。
  weight_slots: [{ name: 'model', label: 'Model', param: 'model_path', applies_at: 'call' }],
};

const ctx = {
  resolveEngineProfile: (id) => {
    if (id !== FAKE_ENGINE.id) throw new Error("这台服务器上没有装引擎 " + id);
    return FAKE_ENGINE;
  },
  resolveRefPath: (raw) => realResolveRefPath(raw),
  pathResolver: realPathResolver,
  loadAdvancedParams: () => ({}),
  pickBestCkpt: () => ({}),
  buildTtsPayload: (text) => ({ text }),
  resolveReference: (cfg) => ({ reference_audio: cfg.reference_audio || 'ref.wav', reference_text: cfg.reference_text || 'hello' }),
  requireApiKey: (q, s, n) => n && n(),
  // 路径常量：合成路径要从 ASSETS_DIR/<voice>/segments.json 读参考音频。
  APP_DIR: ROOT,
  ASSETS_DIR: path.join(ROOT, 'assets'),
  ASSETS_ROOT: path.join(ROOT, 'assets'),
  AUDIO_FORMATS: { wav: 'audio/wav' },
  path,
  // 参考音频从盘上读（ASSETS_DIR/<voice>/segments.json 的第一段已匹配音频），
  // 所以 fs 替身要能应答这条路径。
  fs: {
    mkdirSync() {},
    writeFileSync() {},
    statSync: () => ({ size: 1234 }),
    // segments.json 与参考音频文件都要在：路由先读前者，再查后者。
    existsSync: () => true,
    readFileSync: (p) => String(p).endsWith('segments.json')
      ? JSON.stringify({ segments: [{ matched: true, audio: 'ref.wav', text: 'hello' }] })
      : '',
  },
  clientError: (err, label) => label ? `${label}: ${err.message}` : err.message,
  isBaseVoice: () => false,
  baseVoiceReg: () => ({}),
  resolveSeed: (s) => (s === undefined ? 12345 : Number(s)),
  newGenId: () => "gen_test",
  normSource: (s) => s || "api",
  genAssetDir: () => "/tmp/genfake",
  genBaseName: (x) => String(x).split("/").pop(),
  withGenerationLock: (fn) => fn(),
  switchModels: async () => { if (state.switchThrows) throw new Error("kaboom"); },
  toPcm16Wav: (b) => b,
  generateOneSegment: async () => { if (state.genThrows) throw new Error("boom"); return { length: 10 }; },
  splitJapaneseText: () => state.segments || ["s0", "s1"],
  concatWavFiles: async () => { if (state.concatThrows) throw new Error("boom"); return { method: "ffmpeg" }; },
  computeSegmentBounds: () => ({ bounds: [{ start: 0, end: 1 }, { start: 1, end: 2 }], duration: 2 }),
  writeGenMeta: () => {},
  loadVoices: () => (state.loadThrows ? (() => { throw new Error("boom"); })() : (state.voices || { v: {} })),
};

require(path.join(ROOT, "lib", "routes", "synthesis.js"))(ctx);
const handler = captured["/api/generate"];
if (typeof handler !== "function") { console.error("FAIL: /api/generate handler not captured"); process.exit(1); }

// 替身 req/res
function run(body) {
  // 请求必须点名引擎：平台不代为选择。
  body = { engine_id: FAKE_ENGINE.id, ...body };
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      _status: 200,
      status(c) { this._status = c; return this; },
      json(obj) { this.headersSent = true; resolve({ status: this._status, body: obj }); return this; },
    };
    handler({ body }, res, () => {});
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  -> " + detail : ""}`); }
}

(async () => {
  // 重置替身状态
  const reset = () => Object.keys(state).forEach(k => delete state[k]);

  reset();
  let r = await run({});
  check("missing voice -> 400", r.status === 400 && r.body.error === "Missing 'voice' field", JSON.stringify(r));

  reset();
  r = await run({ voice: "v" });
  check("missing text -> 400", r.status === 400 && r.body.error === "Missing 'text' field", JSON.stringify(r));

  reset();
  r = await run({ voice: "v", text: "x".repeat(5001) });
  check("text too long -> 400", r.status === 400 && /Text too long/.test(r.body.error), JSON.stringify(r));

  reset(); state.loadThrows = true;
  r = await run({ voice: "v", text: "hi" });
  check("voices.json error -> 500", r.status === 500 && r.body.error === "voices.json error: boom", JSON.stringify(r));

  reset(); state.voices = {};
  r = await run({ voice: "v", text: "hi" });
  check("unknown voice -> 404", r.status === 404 && r.body.error === "Unknown voice: v", JSON.stringify(r));

  reset();
  r = await run({ voice: "v", text: "hi" }); // 短文本 ⇒ 不分段
  check("single success -> 200", r.status === 200 && r.body.ok === true && r.body.split === false
    && r.body.concat === false && r.body.audio_url === "/outputs/api/gen_test/audio.wav" && r.body.seed === 12345, JSON.stringify(r));

  const longText = "z".repeat(60); // 超过 softLimit（引擎名片的 max_chars 是 30）⇒ 走分段分支
  reset(); state.genThrows = true;
  r = await run({ voice: "v", text: longText });
  check("segment fail -> 502", r.status === 502 && r.body.ok === false
    && r.body.error === "Segment 0 failed: boom" && Array.isArray(r.body.segments) && r.body.segments.length === 0, JSON.stringify(r));

  reset();
  r = await run({ voice: "v", text: longText, concat: false }); // 分段但不拼接
  check("split no-concat -> 200", r.status === 200 && r.body.ok === true && r.body.split === true
    && r.body.concat === false && Array.isArray(r.body.segments), JSON.stringify(r));

  reset();
  r = await run({ voice: "v", text: longText }); // 分段并拼接成功
  check("concat success -> 200", r.status === 200 && r.body.ok === true && r.body.split === true
    && r.body.concat === true && r.body.concat_method === "ffmpeg" && r.body.duration === 2, JSON.stringify(r));

  reset(); state.concatThrows = true;
  r = await run({ voice: "v", text: longText });
  // 拼接失败是服务端错误：500 + ok:false + 已生成的段仍可试听。
  check("concat fail -> 500 ok:false", r.status === 500 && r.body.ok === false
    && /Audio concatenation failed: boom/.test(r.body.error) && /manual playback/.test(r.body.warning)
    && Array.isArray(r.body.segments), JSON.stringify(r));

  reset(); state.switchThrows = true;
  r = await run({ voice: "v", text: "hi" });
  check("engine throw -> 500 clientError", r.status === 500 && r.body.error === "kaboom", JSON.stringify(r));

  console.log(`\ngenerate service test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
