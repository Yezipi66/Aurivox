// Stage-2 behavioral test for POST /v1/audio/speech (giant handler #2 sunk to a
// service). Builds the synthesis router with a fully stubbed ctx (no engine/GPU/
// fs), captures the registered handler and drives it through EVERY response exit,
// asserting HTTP status + body/binary + headers. This is the 1:1 proof that the
// service/HttpError/RawResponse refactor preserved the original inline handler's
// behavior — including the two structured-object error bodies (ffmpeg_unavailable
// / transcode_failed) and the binary success with its response headers.
// Run from project root:  node tools/tests/speech_service_test.js
const path = require("path");
const Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..");

// ---- express shim that CAPTURES route handlers -----------------------------
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

// ---- mutable test state driving the stub ctx --------------------------------
const state = {};
const AUDIO_FORMATS = {
  wav: { mime: "audio/wav", ext: "wav" },
  mp3: { mime: "audio/mpeg", ext: "mp3" },
};
const ctx = {
  requireApiKey: (q, s, n) => n && n(),
  path,
  fs: {
    // Cross-platform: resolve BOTH sides to an absolute OS path so POSIX-style
    // expected paths (e.g. "/assets/spk/segments.json", "/root/in") match whatever
    // production passes — whether via path.join (drive-relative "\\assets\\...") or
    // path.resolve (drive-absolute "D:\\root\\in"). path.normalize alone does NOT
    // convert separators / add a drive, so it fails for path.resolve output. This
    // is a test-stub-only concern; production uses one OS path convention end-to-end.
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

// ---- mock req/res -----------------------------------------------------------
function run(body) {
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
  check("missing voice -> 400", r.status === 400 && r.body.error === "Missing 'voice' field", JSON.stringify(r));

  reset();
  r = await run({ voice: "spk" });
  check("missing input -> 400", r.status === 400 && r.body.error === "Missing 'input' field", JSON.stringify(r));

  reset();
  r = await run({ voice: "spk", input: "x".repeat(5001) });
  check("input too long -> 400", r.status === 400 && /Input too long/.test(r.body.error), JSON.stringify(r));

  reset(); state.loadThrows = true;
  r = await run({ voice: "spk", input: "hi" });
  check("voices.json error -> 500", r.status === 500 && r.body.error === "voices.json error: boom", JSON.stringify(r));

  // --- recipe path ---
  reset(); state.recipe = { role: "spk", id: "rec1" }; state.voices = {}; // voices lacks role
  r = await run({ voice: "role/name", input: "hi" });
  check("recipe unknown role -> 404", r.status === 404 && /references unknown voice/.test(r.body.error), JSON.stringify(r));

  reset();
  r = await run({ voice: "unknown/name", input: "hi" }); // resolveVoice null
  check("unknown recipe voice -> 404", r.status === 404 && r.body.error === "Unknown recipe voice: unknown/name", JSON.stringify(r));

  reset(); state.recipe = { role: "spk", id: "rec1", reference_audio: "r.wav", reference_text: "t" };
  state.voices = { spk: {} }; state.refReject = true;
  r = await run({ voice: "role/name", input: "hi" });
  check("recipe ref rejected -> 400+code", r.status === 400 && /reference_audio rejected/.test(r.body.error) && r.body.code === "path_escape", JSON.stringify(r));

  // --- whole-voice path ---
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

  // format validation (inside lock)
  reset(); state.voices = { spk: {} };
  r = await run({ voice: "spk", input: "hi", response_format: "flac" });
  check("unsupported format -> 400", r.status === 400 && /Unsupported response_format 'flac'/.test(r.body.error), JSON.stringify(r));

  // ffmpeg unavailable -> structured object body
  reset(); state.voices = { spk: {} }; state.ffmpeg = false;
  r = await run({ voice: "spk", input: "hi", response_format: "mp3" });
  check("ffmpeg unavailable -> 400 object", r.status === 400 && r.body.error && typeof r.body.error === "object"
    && r.body.error.code === "ffmpeg_unavailable" && r.body.error.type === "invalid_request_error"
    && r.body.error.requested_format === "mp3", JSON.stringify(r));

  // engine /tts >= 400
  reset(); state.voices = { spk: {} }; state.gsv = { statusCode: 500, body: Buffer.from("nope") };
  r = await run({ voice: "spk", input: "hi" });
  check("engine /tts fail -> 502", r.status === 502 && /GPT-SoVITS \/tts failed \(500\)/.test(r.body.error), JSON.stringify(r));

  // empty audio
  reset(); state.voices = { spk: {} }; state.gsv = { statusCode: 200, body: Buffer.alloc(0) };
  r = await run({ voice: "spk", input: "hi" });
  check("empty audio -> 502", r.status === 502 && r.body.error === "GPT-SoVITS returned empty audio", JSON.stringify(r));

  // transcode failure -> structured object body, 500
  reset(); state.voices = { spk: {} }; state.ffmpeg = true; state.transcodeThrows = true;
  r = await run({ voice: "spk", input: "hi", response_format: "mp3" });
  check("transcode fail -> 500 object", r.status === 500 && r.body.error && typeof r.body.error === "object"
    && r.body.error.code === "transcode_failed" && r.body.error.requested_format === "mp3", JSON.stringify(r));

  // engine throw (switchModels) -> 500 clientError via format500
  reset(); state.voices = { spk: {} }; state.switchThrows = true;
  r = await run({ voice: "spk", input: "hi" });
  check("engine throw -> 500 clientError", r.status === 500 && r.body.error === "kaboom", JSON.stringify(r));

  // --- SUCCESS: WAV binary ---
  reset(); state.voices = { spk: {} };
  r = await run({ voice: "spk", input: "hi" });
  check("wav success -> binary send", r.kind === "send" && r.status === 200
    && Buffer.isBuffer(r.body) && r.body.toString() === "WAVDATA"
    && r.headers["Content-Type"] === "audio/wav"
    && /attachment; filename="spk_gen_test\.wav"/.test(r.headers["Content-Disposition"])
    && r.headers["X-Voice-Id"] === "spk" && r.headers["X-Audio-Format"] === "wav"
    && !("X-Recipe-Id" in r.headers), JSON.stringify({ status: r.status, kind: r.kind, headers: r.headers }));

  // --- SUCCESS: mp3 transcode + recipe header ---
  reset(); state.recipe = { role: "spk", id: "rec1", reference_audio: "r.wav", reference_text: "t", language: "ja" };
  state.voices = { spk: {} }; state.ffmpeg = true;
  r = await run({ voice: "role/name", input: "hi", response_format: "mp3" });
  check("mp3 success -> transcoded binary + recipe header", r.kind === "send" && r.status === 200
    && r.body.toString() === "MP3DATA" && r.headers["Content-Type"] === "audio/mpeg"
    && r.headers["X-Audio-Format"] === "mp3" && r.headers["X-Recipe-Id"] === "rec1"
    && /filename="rec1_gen_test\.mp3"/.test(r.headers["Content-Disposition"]), JSON.stringify({ status: r.status, kind: r.kind, headers: r.headers }));

  console.log(`\nspeech service test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
