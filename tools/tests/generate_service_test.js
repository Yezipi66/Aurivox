// Stage-2b behavioral test for POST /api/generate.
// Builds the synthesis router with a fully stubbed ctx (no engine/GPU/fs), then
// captures the registered handler and drives it through EVERY response exit,
// asserting HTTP status + body shape. This is the 1:1 proof that the
// service/HttpError refactor preserved the original inline handler's behavior.
// Run from project root:  node tools/tests/generate_service_test.js
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

// ---- stub ctx ---------------------------------------------------------------
const state = {};
const ctx = {
  requireApiKey: (q, s, n) => n && n(),
  path,
  fs: { mkdirSync() {}, writeFileSync() {}, statSync: () => ({ size: 1234 }) },
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

// ---- mock req/res -----------------------------------------------------------
function run(body) {
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
  // reset helper
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
  r = await run({ voice: "v", text: "hi" }); // short -> single
  check("single success -> 200", r.status === 200 && r.body.ok === true && r.body.split === false
    && r.body.concat === false && r.body.audio_url === "/outputs/api/gen_test/audio.wav" && r.body.seed === 12345, JSON.stringify(r));

  const longText = "z".repeat(60); // > softLimit(45) -> split branch
  reset(); state.genThrows = true;
  r = await run({ voice: "v", text: longText });
  check("segment fail -> 502", r.status === 502 && r.body.ok === false
    && r.body.error === "Segment 0 failed: boom" && Array.isArray(r.body.segments) && r.body.segments.length === 0, JSON.stringify(r));

  reset();
  r = await run({ voice: "v", text: longText, concat: false }); // split, no concat
  check("split no-concat -> 200", r.status === 200 && r.body.ok === true && r.body.split === true
    && r.body.concat === false && Array.isArray(r.body.segments), JSON.stringify(r));

  reset();
  r = await run({ voice: "v", text: longText }); // split + concat success
  check("concat success -> 200", r.status === 200 && r.body.ok === true && r.body.split === true
    && r.body.concat === true && r.body.concat_method === "ffmpeg" && r.body.duration === 2, JSON.stringify(r));

  reset(); state.concatThrows = true;
  r = await run({ voice: "v", text: longText });
  check("concat fail -> 200 ok:false", r.status === 200 && r.body.ok === false
    && r.body.error === "Audio concatenation failed: boom" && /manual playback/.test(r.body.warning), JSON.stringify(r));

  reset(); state.switchThrows = true;
  r = await run({ voice: "v", text: "hi" });
  check("engine throw -> 500 clientError", r.status === 500 && r.body.error === "kaboom", JSON.stringify(r));

  console.log(`\ngenerate service test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
