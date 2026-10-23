// POST /v1/audio/speech 的行为测试：用一套全替身的 ctx 建出合成路由，
// 抓取注册好的 handler，把每一条响应出口都走一遍，断言状态码、响应体与响应头。
// 覆盖的是把 handler 从路由里搬进服务层之后行为没有变：两个结构化错误体
// （ffmpeg_unavailable / transcode_failed）与带响应头的二进制成功响应。
// 运行方式（在项目根）：node tools/tests/speech_service.node.test.js
const path = require("path");
const Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..");

const realResolveRefPath = require(path.join(ROOT, 'lib', 'server', 'paths')).resolveRefPath;
const realPathResolver = require(path.join(ROOT, 'lib', 'pathResolver'));


// 冒充 express：Router.post 把注册的 handler 抓下来，供本文件直接调用。
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

// 可变的测试状态：下面的替身靠它切换分支（缺文件、抛错、引擎返回码等）。
const state = {};
const AUDIO_FORMATS = {
  wav: { mime: "audio/wav", ext: "wav" },
  mp3: { mime: "audio/mpeg", ext: "mp3" },
};
// 假引擎：请求点名了哪台就返回哪台。位表是空的：
// 这个文件测的是「请求到响应」的形状，不测模型位的挑选。
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
  weight_slots: [],
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
  // 参考音频解析：请求里给了就原样带出，没给就空。
  resolveReference: (cfg) => ({
    reference_audio: cfg.reference_audio || 'ref.wav',
    reference_text: cfg.reference_text || 'hello',
  }),
  isBaseVoice: (v) => v === '__base__',
  requireApiKey: (q, s, n) => n && n(),
  path,
  fs: {
    // 跨平台：把两边都解析成绝对路径，这样 POSIX 风格的预期路径
    // （如 "/assets/spk/segments.json"）既能对上 path.join 出来的
    // 盘符相对路径，也能对上 path.resolve 出来的盘符绝对路径。
    // 只做 path.normalize 既不统一分隔符也不补盘符，path.resolve 的输出对不上。
    // 这只是测试替身要考虑的事；生产代码全程只用一种路径写法。
    existsSync: (p) => (state.missingPaths ? !state.missingPaths.some((m) => path.resolve(m) === path.resolve(p)) : true),
    readFileSync: () => JSON.stringify(state.segments || { segments: [{ matched: true, audio: "ref.wav", text: "hello" }] }),
    mkdirSync() {},
    writeFileSync() {},
  },
  ASSETS_DIR: "/assets",
  APP_DIR: "/app",
  AUDIO_FORMATS,
  clientError: (err, label) => label ? `${label}: ${err.message}` : err.message,
  loadVoices: () => (state.loadThrows ? (() => { throw new Error("boom"); })() : (state.voices || { spk: {} })),
  loadAdvancedParams: () => ({ temperature: 1, top_k: 5, top_p: 1, repetition_penalty: 1, text_split_method: "cut0", seed: -1, sample_steps: 8, if_sr: false, batch_size: 1, batch_threshold: 0.75, split_bucket: true, fragment_interval: 0.3, parallel_infer: true }),
  recipeStore: { resolveVoice: (v) => state.recipe || null },
  pathResolver: { resolveManagedRef: (p) => (state.refReject ? { ok: false, error: "escape", code: "path_escape" } : { ok: true, path: typeof p === "string" ? p : (p && p.path) || "ref.wav" }) },
  resolveRefPath: (r) => r,
  pickBestCkpt: (a) => a && a[0],
  resolveSeed: (s) => (s === -1 || s === undefined ? 4242 : Number(s)),
  newGenId: () => "gen_test",
  genAssetDir: () => "/tmp/genfake",
  genBaseName: (x) => String(x).split("/").pop(),
  writeGenMeta: () => {},
  buildTtsPayload: (input, cfg) => ({ text: input }),
  switchModels: async () => { if (state.switchThrows) throw new Error("kaboom"); },
  checkFfmpeg: () => !!state.ffmpeg,
  transcodeAudio: (buf, fmt) => { if (state.transcodeThrows) throw new Error("badcodec"); return Buffer.from("MP3DATA"); },
  gsvPost: async () => (state.gsv || { statusCode: 200, body: Buffer.from("WAVDATA") }),
  withGenerationLock: (fn) => fn(),
};

require(path.join(ROOT, "lib", "routes", "synthesis.js"))(ctx);
const handler = captured["/v1/audio/speech"];
if (typeof handler !== "function") { console.error("FAIL: /v1/audio/speech handler not captured"); process.exit(1); }

// 冒充 req / res：res 把状态码、响应头与响应体记下来，交回一个可判定形状。
function run(body) {
  // 请求必须点名引擎：平台不代为选择。
  body = { engine_id: FAKE_ENGINE.id, ...body };
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      _status: 200,
      _headers: {},
      status(c) { this._status = c; return this; },
      set(k, v) { this._headers[k] = v; return this; },
      json(obj) { this.headersSent = true; resolve({ kind: "json", status: this._status, body: obj, headers: this._headers }); return this; },
      send(buf) { this.headersSent = true; resolve({ kind: "send", status: this._status, body: buf, headers: this._headers }); return this; },
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
  const reset = () => Object.keys(state).forEach(k => delete state[k]);

  reset();
  let r = await run({});
  check("missing voice -> 400", r.status === 400 && /Missing 'voice'|Missing 'model'/.test(r.body.error), JSON.stringify(r));

  reset();
  r = await run({ voice: "spk" });
  check("missing input -> 400", r.status === 400 && r.body.error === "Missing 'input' field", JSON.stringify(r));

  reset();
  r = await run({ voice: "spk", input: "x".repeat(5001) });
  check("input too long -> 400", r.status === 400 && /Input too long/.test(r.body.error), JSON.stringify(r));

  reset(); state.loadThrows = true;
  r = await run({ voice: "spk", input: "hi" });
  check("voices.json error -> 500", r.status === 500 && r.body.error === "voices.json error: boom", JSON.stringify(r));

  // 配方路径
  reset(); state.recipe = { role: "spk", id: "rec1" }; state.voices = {}; // voices lacks role
  r = await run({ voice: "role/name", input: "hi" });
  check("recipe unknown role -> 404", r.status === 404 && /references unknown voice/.test(r.body.error), JSON.stringify(r));

  reset();
  r = await run({ voice: "unknown/name", input: "hi" }); // resolveVoice null
  check("unknown recipe voice -> 404", r.status === 404 && r.body.error === "Unknown recipe voice: unknown/name", JSON.stringify(r));

  reset(); state.recipe = { role: "spk", id: "rec1", reference_audio: "r.wav", reference_text: "t" };
  state.voices = { spk: {} }; state.refReject = true;
  r = await run({ voice: "role/name", input: "hi" });
  // 配方必须自己写明用哪台引擎：没写就 400 + RECIPE_NO_ENGINE。
  check("recipe without engine -> 400+code", r.status === 400 && r.body.code === "RECIPE_NO_ENGINE", JSON.stringify(r));

  // 裸音色路径
  reset(); state.voices = {};
  r = await run({ voice: "spk", input: "hi" });
  check("unknown voice -> 404", r.status === 404 && r.body.error === "Unknown voice: spk", JSON.stringify(r));

  reset(); state.voices = { spk: {} }; state.missingPaths = ["/assets/spk/segments.json"];
  r = await run({ voice: "spk", input: "hi" });
  check("no segments.json -> 400", r.status === 400 && /has no segments.json/.test(r.body.error), JSON.stringify(r));

  reset(); state.voices = { spk: {} };
  state.segments = { segments: [] }; // no matched -> refAudio empty
  r = await run({ voice: "spk", input: "hi" });
  check("no matched ref -> 400", r.status === 400 && /no matched reference audio/.test(r.body.error), JSON.stringify(r));

  // 响应格式校验（在锁内）
  reset(); state.voices = { spk: {} };
  r = await run({ voice: "spk", input: "hi", response_format: "flac" });
  check("unsupported format -> 400", r.status === 400 && /Unsupported response_format 'flac'/.test(r.body.error), JSON.stringify(r));

  // ffmpeg 不可用：结构化错误体
  reset(); state.voices = { spk: {} }; state.ffmpeg = false;
  r = await run({ voice: "spk", input: "hi", response_format: "mp3" });
  check("ffmpeg unavailable -> 400 object", r.status === 400 && r.body.error && typeof r.body.error === "object"
    && r.body.error.code === "ffmpeg_unavailable" && r.body.error.type === "invalid_request_error"
    && r.body.error.requested_format === "mp3", JSON.stringify(r));

  // 引擎 /tts 返回 >= 400
  reset(); state.voices = { spk: {} }; state.gsv = { statusCode: 500, body: Buffer.from("nope") };
  r = await run({ voice: "spk", input: "hi" });
  // 报错文案点名的是这次真的在用的那台引擎（它的 label），不是写死的名字。
  check("engine /tts fail -> 502", r.status === 502 && /Test Engine \/tts failed \(500\)/.test(r.body.error), JSON.stringify(r));

  // 引擎返回空音频
  reset(); state.voices = { spk: {} }; state.gsv = { statusCode: 200, body: Buffer.alloc(0) };
  r = await run({ voice: "spk", input: "hi" });
  check("empty audio -> 502", r.status === 502 && r.body.error === "Test Engine returned empty audio", JSON.stringify(r));

  // 转码失败：结构化错误体，500
  reset(); state.voices = { spk: {} }; state.ffmpeg = true; state.transcodeThrows = true;
  r = await run({ voice: "spk", input: "hi", response_format: "mp3" });
  check("transcode fail -> 500 object", r.status === 500 && r.body.error && typeof r.body.error === "object"
    && r.body.error.code === "transcode_failed" && r.body.error.requested_format === "mp3", JSON.stringify(r));

  // 引擎抛错（switchModels）：经 clientError 变成 500
  reset(); state.voices = { spk: {} }; state.switchThrows = true;
  r = await run({ voice: "spk", input: "hi" });
  check("engine throw -> 500 clientError", r.status === 500 && r.body.error === "kaboom", JSON.stringify(r));

  // 成功：WAV 二进制
  reset(); state.voices = { spk: {} };
  r = await run({ voice: "spk", input: "hi" });
  check("wav success -> binary send", r.kind === "send" && r.status === 200
    && Buffer.isBuffer(r.body) && r.body.toString() === "WAVDATA"
    && r.headers["Content-Type"] === "audio/wav"
    && /attachment; filename="spk_gen_test\.wav"/.test(r.headers["Content-Disposition"])
    && r.headers["X-Voice-Id"] === "spk" && r.headers["X-Audio-Format"] === "wav"
    && !("X-Recipe-Id" in r.headers), JSON.stringify({ status: r.status, kind: r.kind, headers: r.headers }));

  // 成功：mp3 转码 + 配方响应头
  // 配方路径：配方自己写明用哪台引擎。
  reset(); state.recipe = { role: "spk", id: "rec1", reference_audio: "r.wav", reference_text: "t", language: "ja", engine_id: FAKE_ENGINE.id };
  state.voices = { spk: {} }; state.ffmpeg = true;
  r = await run({ voice: "role/name", input: "hi", response_format: "mp3" });
  check("mp3 success -> transcoded binary + recipe header", r.kind === "send" && r.status === 200
    && r.body.toString() === "MP3DATA" && r.headers["Content-Type"] === "audio/mpeg"
    && r.headers["X-Audio-Format"] === "mp3" && r.headers["X-Recipe-Id"] === "rec1"
    && /filename="rec1_gen_test\.mp3"/.test(r.headers["Content-Disposition"]), JSON.stringify({ status: r.status, kind: r.kind, headers: r.headers }));

  console.log(`\nspeech service test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
