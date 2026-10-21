// Stage-2 behavioral test for POST /api/train/start (giant handler #3 sunk to a
// service). Builds the training router with a fully stubbed ctx (no engine/GPU/
// fs), captures the registered handler and drives it through EVERY response exit,
// asserting HTTP status + body (incl. error `code`s). 1:1 proof the service/
// HttpError refactor preserved the original inline handler's behavior.
// Run from project root:  node tools/tests/train_start_service_test.js
const path = require("path");
const Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..");

const captured = {};
const expressShim = function () { const a = {}; for (const m of ["get","post","put","delete","patch","use","all"]) a[m] = () => a; return a; };
expressShim.Router = function () {
  const r = {};
  for (const m of ["get","put","delete","patch","use","all"]) r[m] = () => r;
  r.post = (p, ...h) => { captured[p] = h[h.length - 1]; return r; };
  return r;
};
expressShim.static = () => (q, s, n) => n && n();
expressShim.json = () => (q, s, n) => n && n();
expressShim.urlencoded = () => (q, s, n) => n && n();
const orig = Module._load;
Module._load = function (request) { if (request === "express") return expressShim; return orig.apply(this, arguments); };

const state = {};
const ctx = {
  requireApiKey: (q, s, n) => n && n(),
  path,
  fs: {
    // Cross-platform: resolve BOTH sides to an absolute OS path so POSIX-style
    // expected paths match production output from either path.join or path.resolve.
    // path.normalize alone doesn't convert separators / add a drive. Test-stub-only.
    existsSync: (p) => (state.missingPaths ? !state.missingPaths.some((m) => path.resolve(m) === path.resolve(p)) : true),
    readFileSync: () => JSON.stringify(state.meta || { display_name: "Parent" }),
    statSync: () => ({ isDirectory: () => !state.notDir }),
  },
  ALLOWED_LANGUAGES: new Set(["ja", "zh", "en"]),
  ASSETS_DIR: "/assets",
  TRAIN_DATA_ROOT: "/root",
  assetId: { allocateVoiceId: () => "newid", reserve() {}, release() {} },
  clientError: (err) => err.message,
  collectTakenVoiceIds: () => [],
  loadVoices: () => (state.voices || {}),
  safeId: (id) => !state.invalidTarget,
  sanitizeCustomParams: (c) => ({ training: (c && c.training) || {} }),
  checkBaseModelsForVersion: (v) => (state.blocked ? { blocking: true, version: v, criticalMissing: ["s2G"] } : { blocking: false }),
  trainingPipeline: {
    readTaskJournal: () => state.journal || null,
    createPipeline: () => { if (state.createThrows) throw new Error("kaboom"); return { id: "task_1", start: async () => {} }; },
  },
  withVoicesLock: (fn) => fn(),
};

require(path.join(ROOT, "lib", "routes", "training.js"))(ctx);
const handler = captured["/api/train/start"];
if (typeof handler !== "function") { console.error("FAIL: /api/train/start handler not captured"); process.exit(1); }

function run(body) {
  return new Promise((resolve) => {
    const res = { headersSent: false, _status: 200,
      status(c) { this._status = c; return this; },
      json(obj) { this.headersSent = true; resolve({ status: this._status, body: obj }); return this; } };
    handler({ body }, res, () => {});
  });
}
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? "  -> " + d : ""}`); } };
const ok = { displayName: "Spk", language: "ja", inputDir: "/root/in" };

(async () => {
  const reset = () => Object.keys(state).forEach(k => delete state[k]);

  reset(); let r = await run({});
  check("missing displayName -> 400", r.status === 400 && r.body.error === "Missing 'displayName'", JSON.stringify(r));

  reset(); r = await run({ displayName: "Spk" });
  check("missing language -> 400", r.status === 400 && r.body.error === "Missing 'language'", JSON.stringify(r));

  reset(); r = await run({ displayName: "Spk", language: "ja" });
  check("missing inputDir -> 400", r.status === 400 && r.body.error === "Missing 'inputDir'", JSON.stringify(r));

  reset(); state.journal = null; r = await run({ resumeTaskId: "t9", language: "ja", inputDir: "/root/in" });
  check("resume no voiceId -> 400", r.status === 400 && r.body.code === "RESUME_NO_VOICEID", JSON.stringify(r));

  reset(); state.invalidTarget = true; r = await run({ displayName: "Spk", language: "ja", inputDir: "/root/in", targetVoiceId: "!!" });
  check("invalid targetVoiceId -> 400", r.status === 400 && r.body.error === "Invalid targetVoiceId", JSON.stringify(r));

  reset(); state.missingPaths = ["/assets/tgt/meta.json"]; state.voices = {};
  r = await run({ displayName: "Spk", language: "ja", inputDir: "/root/in", targetVoiceId: "tgt" });
  check("target not found -> 404", r.status === 404 && r.body.code === "TARGET_NOT_FOUND", JSON.stringify(r));

  reset(); state.meta = { display_name: "Existing" };
  r = await run({ displayName: "Spk", language: "ja", inputDir: "/root/in", targetVoiceId: "tgt" }); // overwrite false
  check("voice exists -> 409", r.status === 409 && r.body.code === "VOICE_EXISTS" && r.body.existingId === "tgt" && r.body.existingDisplay === "Existing", JSON.stringify(r));

  reset(); r = await run({ ...ok, steps: { slice: false, copyRaw: false } });
  check("no reference audio -> 400", r.status === 400 && r.body.code === "NO_REFERENCE_AUDIO", JSON.stringify(r));

  reset(); state.blocked = true; r = await run({ ...ok });
  check("base models missing -> 412", r.status === 412 && r.body.code === "BASE_MODELS_MISSING" && Array.isArray(r.body.versions), JSON.stringify(r));

  reset(); r = await run({ displayName: "Spk", language: "kr", inputDir: "/root/in" });
  check("invalid language -> 400", r.status === 400 && /Invalid language: kr/.test(r.body.error), JSON.stringify(r));

  reset(); r = await run({ ...ok, inputDir: "/elsewhere/in" });
  check("inputDir under root -> 400", r.status === 400 && r.body.error === "inputDir must be under TRAIN_DATA_ROOT", JSON.stringify(r));

  reset(); state.missingPaths = ["/root/in"]; r = await run({ ...ok });
  check("inputDir not exist -> 400", r.status === 400 && /does not exist/.test(r.body.error), JSON.stringify(r));

  reset(); r = await run({ ...ok });
  check("success -> 200", r.status === 200 && r.body.ok === true && r.body.taskId === "task_1" && r.body.voiceId === "newid" && r.body.displayName === "Spk", JSON.stringify(r));

  reset(); state.createThrows = true; r = await run({ ...ok });
  check("createPipeline throw -> 500 clientError", r.status === 500 && r.body.error === "kaboom", JSON.stringify(r));

  console.log(`\ntrain/start service test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
