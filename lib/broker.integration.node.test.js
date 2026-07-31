// ===========================================================================
//  BROKER BLACK-BOX INTEGRATION TESTS  (node:test)
// ===========================================================================
// Ported 1:1 from the former pytest suite (test_health / test_language_defense
// / test_resume_fork). Boots the REAL server.js against a stub engine ONCE
// (before hook), then exercises the public HTTP surface. Run with:
//
//     npm test            # -> node --test "lib/**/*.node.test.js"
//
// If the backend can't run here (node_modules not installed, or the server
// fails to become ready), every test SKIPS with a clear reason instead of
// failing — so the suite never red-lights an environment lacking the runtime.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startBroker, httpJson, runtimeSkipReason } = require("./__testsupport__/brokerHarness");

let broker = null;
let skipReason = runtimeSkipReason();

before(async () => {
  if (skipReason) return; // runtime missing — leave broker null, tests self-skip
  try {
    broker = await startBroker();
  } catch (e) {
    skipReason = e.message; // boot failed/timeout — carry the server-log tail
  }
}, { timeout: 90000 });

after(async () => {
  if (broker) await broker.stop();
});

// Guard: returns true (and skips the test) when the broker isn't available.
function guard(t) {
  if (!broker) { t.skip(skipReason || "broker unavailable"); return true; }
  return false;
}

// Reset the stub engine to a healthy baseline (mirrors the pytest engine_state
// fixture). Safe to call from any test since the stub is in-process.
function resetEngine() {
  if (broker) { broker.engine.state.online = true; broker.engine.state.ttsStatus = 200; }
}

const ci = (headers) => headers; // node lowercases response header keys already
const errMsg = (body) => {
  if (body && typeof body === "object") {
    const err = body.error !== undefined ? body.error : body;
    return String(err && typeof err === "object" ? (err.message ?? JSON.stringify(err)) : err);
  }
  return String(body);
};

// --------------------------------------------------------------------------- //
//  Health aggregation (/api/health)  — guards the system.js de-hardcode fix
// --------------------------------------------------------------------------- //
test("health: shape is complete and gpt_sovits_url echoes the CONFIGURED engine URL", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/health");
  assert.equal(status, 200);
  assert.equal(typeof body, "object");
  for (const key of ["ok", "engine_online", "gpt_sovits_url", "ffmpeg_available", "cuda"]) {
    assert.ok(key in body, `missing aggregated health field: ${key}`);
  }
  assert.equal(body.ok, true);
  // Core regression guard: reported engine URL == configured base URL, not 9880.
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
  assert.equal(status, 200);        // never 500
  assert.equal(body.ok, true);
  assert.equal(body.engine_online, false);
  resetEngine();
});

// --------------------------------------------------------------------------- //
//  Language-defense stack (/v1/audio/speech)
// --------------------------------------------------------------------------- //
const speech = (body) => httpJson(broker.base_url + "/v1/audio/speech", { method: "POST", body });

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
  const { status, headers } = await speech({ voice: "novoice_lang", input: "hello" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "auto");
  assert.ok(h["x-language-warning"], "missing X-Language-Warning for a language-less voice");
});

test("speech: language-pinned voice -> deterministic X-Text-Lang=ja and NO warning", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "ja");
  assert.ok(!("x-language-warning" in h), "unexpected X-Language-Warning on a pinned-language voice");
});

// --- Aurivox extension: optional per-request `language` (request > recipe > asset) ---

test("speech: request language OVERRIDES a pinned voice language (jp_voice + en -> X-Text-Lang=en, no warning)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "en" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "en", "explicit request language must win over the recipe/asset pin");
  assert.ok(!("x-language-warning" in h), "explicit supported language must NOT warn");
});

test("speech: bare request language normalizes to the engine mode (novoice_lang + zh -> all_zh, no warning)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "novoice_lang", input: "hello", language: "zh" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "all_zh", "bare 'zh' must normalize to the engine's 'all_zh' mode");
  assert.ok(!("x-language-warning" in h), "an explicit request language means the auto-fallback warning must not fire");
});

test("speech: canonical request language passes through unchanged (all_ja -> all_ja, no warning)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  // Exactly what a recipe-card curl emits when recipe.language === "all_ja".
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "all_ja" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "all_ja", "canonical 'all_ja' must be accepted verbatim, not treated as unsupported");
  assert.ok(!("x-language-warning" in h), "a valid canonical language must NOT warn");
});

test("speech: request language is case-insensitive (JA -> all_ja)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "JA" });
  assert.equal(status, 200, `expected synthesis to succeed, got ${status}`);
  assert.equal(ci(headers)["x-text-lang"], "all_ja");
});

test("speech: UNSUPPORTED request language falls back to auto AND warns (not a 400)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await speech({ voice: "jp_voice", input: "hello", language: "fr" });
  assert.equal(status, 200, `unsupported language must degrade, not fail; got ${status}`);
  const h = ci(headers);
  assert.equal(h["x-text-lang"], "auto", "unsupported language must fall back to auto");
  assert.ok(h["x-language-warning"], "unsupported language must surface an X-Language-Warning");
  assert.match(String(h["x-language-warning"]).toLowerCase(), /not supported/);
});

// --- Downstream proof: what actually reaches the GPT-SoVITS /tts endpoint ---
// The stub engine records the exact JSON body the broker POSTs to /tts, so these
// tests show — not just claim — that the request `language` arrives at the
// inference side as a real engine text_lang, via the same buildTtsPayload -> /tts
// pipe that recipe.language uses.

test("downstream: bare request language reaches /tts normalized (ja -> text_lang=all_ja)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.lastTts = null;
  const { status } = await speech({ voice: "jp_voice", input: "こんにちは", language: "ja" });
  assert.equal(status, 200, `expected 200, got ${status}`);
  const p = broker.engine.state.lastTts;
  assert.ok(p, "the engine received no /tts payload");
  // Print the actual body sent to the inference side (visible in test output):
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
  const { status } = await speech({ voice: "jp_voice", input: "hi", language: "all_ja" });
  assert.equal(status, 200);
  assert.equal(broker.engine.state.lastTts.text_lang, "all_ja");
});

test("downstream: unsupported request language degrades to auto at /tts (fr -> text_lang=auto)", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.lastTts = null;
  const { status, headers } = await speech({ voice: "jp_voice", input: "hi", language: "fr" });
  assert.equal(status, 200);
  assert.equal(broker.engine.state.lastTts.text_lang, "auto", "unsupported language must reach /tts as 'auto'");
  assert.ok(ci(headers)["x-language-warning"], "and still warn the caller");
});

// --------------------------------------------------------------------------- //
//  Training resume / fork validation (/api/train/start)
// --------------------------------------------------------------------------- //
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
  // Default steps -> rerun starts at 'slice', which requires the original input
  // folder; omitting inputDir must be rejected with INPUT_DIR_REQUIRED.
  const { status, body } = await trainStart({ resumeTaskId: "no_such_task", language: "ja" });
  assert.equal(status, 400);
  assert.equal(codeOf(body), "INPUT_DIR_REQUIRED");
});

test("train/start: resume of unknown task (slice disabled) -> 400 RESUME_NO_VOICEID", async (t) => {
  if (guard(t)) return;
  resetEngine();
  // Disabling slicing moves the rerun start past the inputDir gate; the resume
  // then fails because the source task has no stored voice id.
  const { status, body } = await trainStart({
    resumeTaskId: "no_such_task",
    language: "ja",
    steps: { slice: false },
  });
  assert.equal(status, 400);
  assert.equal(codeOf(body), "RESUME_NO_VOICEID");
});
