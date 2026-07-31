// Zero-dependency unit tests for the same-model request-coalescing switcher
// (Point 4), using Node's BUILT-IN test runner — no jest, no install:
//
//     node --test               # runs every *.test.js under the repo
//     node --test lib/gsv/      # or just this folder
//
// Contract under test (see modelState.js):
//   * first request for a weight pair => real switch (both HTTP calls)
//   * an immediately-repeated identical request => SKIPPED (coalesced)
//   * a falsy model field => no-op, resident weights untouched
//   * a failed switch => that cache slot cleared + throws => next call re-switches
//   * reset() => whole cache invalidated (engine-restart case)

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ModelSwitcher } = require("./modelState");

// Mock gsvGet that records calls; `reply` may be a fixed object or a function.
function makeGet(reply) {
  const calls = [];
  const fn = async (pathStr, params) => {
    calls.push({ pathStr, params });
    const res = typeof reply === "function" ? reply(pathStr, params) : reply;
    return res || { statusCode: 200, body: Buffer.from("ok") };
  };
  fn.calls = calls;
  return fn;
}

const OK = { statusCode: 200, body: Buffer.from("ok") };
const CFG = { gpt_model: "/models/a.ckpt", sovits_model: "/models/a.pth" };

test("constructor rejects a non-function gsvGet", () => {
  assert.throws(() => new ModelSwitcher(null), TypeError);
  assert.throws(() => new ModelSwitcher({}), /requires a gsvGet/);
});

test("first ensure() switches BOTH weights and issues two HTTP calls", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  const r = await sw.ensure(CFG);
  assert.deepEqual(r, { switchedGpt: true, switchedSovits: true, skippedGpt: false, skippedSovits: false });
  assert.deepEqual(get.calls.map(c => c.pathStr), ["/set_gpt_weights", "/set_sovits_weights"]);
  assert.deepEqual(get.calls[0].params, { weights_path: CFG.gpt_model });
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: CFG.sovits_model });
});

test("repeated identical request is fully coalesced (zero new HTTP calls)", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  const r = await sw.ensure(CFG);
  assert.deepEqual(r, { switchedGpt: false, switchedSovits: false, skippedGpt: true, skippedSovits: true });
  assert.equal(get.calls.length, 2);
});

test("mixed: GPT changes, SoVITS unchanged => only GPT re-switches", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  const r = await sw.ensure({ gpt_model: "/models/b.ckpt", sovits_model: CFG.sovits_model });
  assert.deepEqual(r, { switchedGpt: true, switchedSovits: false, skippedGpt: false, skippedSovits: true });
  assert.equal(get.calls.length, 3);
  assert.deepEqual(get.calls[2], { pathStr: "/set_gpt_weights", params: { weights_path: "/models/b.ckpt" } });
  assert.deepEqual(sw.loaded, { gpt: "/models/b.ckpt", sovits: CFG.sovits_model });
});

test("falsy model field is a no-op and leaves resident weights untouched", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  get.calls.length = 0;
  const r = await sw.ensure({ gpt_model: "", sovits_model: null });
  assert.deepEqual(r, { switchedGpt: false, switchedSovits: false, skippedGpt: false, skippedSovits: false });
  assert.equal(get.calls.length, 0);
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: CFG.sovits_model });
});

test("a failed switch clears that slot, throws, and NEVER false-skips afterward", async () => {
  let gptShouldFail = true;
  const get = makeGet((pathStr) =>
    pathStr === "/set_gpt_weights" && gptShouldFail
      ? { statusCode: 500, body: Buffer.from("boom") }
      : OK);
  const sw = new ModelSwitcher(get);
  await assert.rejects(sw.ensure(CFG), /set_gpt_weights failed \(500\): boom/);
  assert.equal(sw.loaded.gpt, null);
  gptShouldFail = false;
  get.calls.length = 0;
  const r = await sw.ensure(CFG);
  assert.equal(r.switchedGpt, true);
  assert.ok(get.calls.some(c => c.pathStr === "/set_gpt_weights"));
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: CFG.sovits_model });
});

test("reset() invalidates the whole cache => next ensure re-switches both", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  sw.reset();
  assert.deepEqual(sw.loaded, { gpt: null, sovits: null });
  get.calls.length = 0;
  const r = await sw.ensure(CFG);
  assert.deepEqual(r, { switchedGpt: true, switchedSovits: true, skippedGpt: false, skippedSovits: false });
  assert.equal(get.calls.length, 2);
});

// ---- engine-liveness gate: restart (offline->online) invalidates the cache ----

test("noteEngineHealth: offline->online flip resets the cache (engine restarted)", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);                       // both weights resident
  assert.equal(sw.noteEngineHealth(true), false);  // first probe (unknown->online): no reset
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: CFG.sovits_model });
  assert.equal(sw.noteEngineHealth(false), false); // engine went down: still no reset
  assert.equal(sw.noteEngineHealth(true), true);   // came back: THIS flip resets
  assert.deepEqual(sw.loaded, { gpt: null, sovits: null });
  get.calls.length = 0;
  const r = await sw.ensure(CFG);             // next synthesis re-switches both
  assert.deepEqual(r, { switchedGpt: true, switchedSovits: true, skippedGpt: false, skippedSovits: false });
  assert.equal(get.calls.length, 2);
});

test("noteEngineHealth: steady online (true->true) never resets", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  sw.noteEngineHealth(true);
  assert.equal(sw.noteEngineHealth(true), false);  // no outage -> no reset
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: CFG.sovits_model });
  const r = await sw.ensure(CFG);                  // still coalesced
  assert.deepEqual(r, { switchedGpt: false, switchedSovits: false, skippedGpt: true, skippedSovits: true });
});

// ---- gap coverage: symmetry, partial success, transport errors, boundaries ----

test("SoVITS-side failure is symmetric to GPT: clears sovits slot + throws", async () => {
  const get = makeGet((p) =>
    p === "/set_sovits_weights" ? { statusCode: 503, body: Buffer.from("nope") } : OK);
  const sw = new ModelSwitcher(get);
  await assert.rejects(sw.ensure(CFG), /set_sovits_weights failed \(503\): nope/);
  // GPT switched successfully BEFORE the sovits failure -> its slot stays set;
  // only the sovits slot is invalidated.
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: null });
});

test("partial success (GPT ok, SoVITS fails) then recovery re-switches ONLY sovits", async () => {
  let sovitsFail = true;
  const get = makeGet((p) =>
    p === "/set_sovits_weights" && sovitsFail ? { statusCode: 500, body: Buffer.from("x") } : OK);
  const sw = new ModelSwitcher(get);
  await assert.rejects(sw.ensure(CFG));
  assert.deepEqual(sw.loaded, { gpt: CFG.gpt_model, sovits: null });

  sovitsFail = false;
  get.calls.length = 0;
  const r = await sw.ensure(CFG);
  // GPT already resident -> skipped; SoVITS was cleared -> re-switched.
  assert.deepEqual(r, { switchedGpt: false, switchedSovits: true, skippedGpt: true, skippedSovits: false });
  assert.deepEqual(get.calls.map(c => c.pathStr), ["/set_sovits_weights"]);
});

test("transport-level reject (gsvGet throws, not a 4xx) propagates and does NOT falsely advance the cache", async () => {
  // Warm to a known pair first.
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  // Now the next GPT switch rejects at the transport layer (e.g. ECONNREFUSED).
  const boom = new Error("ECONNREFUSED");
  sw._gsvGet = async () => { throw boom; };
  await assert.rejects(sw.ensure({ gpt_model: "/models/new.ckpt", sovits_model: CFG.sovits_model }), /ECONNREFUSED/);
  // The switch never completed, so the cache must NOT record the new model.
  assert.notEqual(sw.loaded.gpt, "/models/new.ckpt");
});

test("status boundary: 399 is success, 400 is failure", async () => {
  const sw399 = new ModelSwitcher(makeGet({ statusCode: 399, body: Buffer.from("ok-ish") }));
  const r = await sw399.ensure({ gpt_model: "/g" });
  assert.equal(r.switchedGpt, true);
  assert.equal(sw399.loaded.gpt, "/g");

  const sw400 = new ModelSwitcher(makeGet({ statusCode: 400, body: Buffer.from("bad") }));
  await assert.rejects(sw400.ensure({ gpt_model: "/g" }), /set_gpt_weights failed \(400\)/);
  assert.equal(sw400.loaded.gpt, null);
});

test("ensure() with no/empty cfg is a safe no-op (defensive cfg||{})", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  const r1 = await sw.ensure();       // undefined
  const r2 = await sw.ensure({});     // empty object
  const none = { switchedGpt: false, switchedSovits: false, skippedGpt: false, skippedSovits: false };
  assert.deepEqual(r1, none);
  assert.deepEqual(r2, none);
  assert.equal(get.calls.length, 0);
  assert.deepEqual(sw.loaded, { gpt: null, sovits: null });
});

test("GPT is always switched BEFORE SoVITS (deterministic ordering)", async () => {
  const get = makeGet(OK);
  const sw = new ModelSwitcher(get);
  await sw.ensure(CFG);
  assert.deepEqual(get.calls.map(c => c.pathStr), ["/set_gpt_weights", "/set_sovits_weights"]);
});

test("empty-string body on failure yields a clean '(code): ' message (no crash)", async () => {
  const sw = new ModelSwitcher(makeGet({ statusCode: 500, body: Buffer.from("") }));
  await assert.rejects(sw.ensure({ gpt_model: "/g" }), /set_gpt_weights failed \(500\): $/);
});
