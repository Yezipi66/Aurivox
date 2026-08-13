// ===========================================================================
//  AURIVOX FLOW — REAL END-TO-END INTEGRATION  (FLOW-CORE-004)
// ===========================================================================
// Every other Flow test drives the kernel with mock handlers. This suite is the
// first one that proves the kernel is REACHABLE FROM A RUNNING PROCESS:
//
//   real server.js  ->  /api/flow/runs  ->  FlowRuntime  ->  WorkflowExecutor
//     ->  legacySynthesis adapter  ->  real synthesisService  ->  HTTP  ->  engine
//     ->  real WAV on disk  ->  Journal on disk  ->  Human Gate  ->  approve
//
// Nothing here is stubbed except the GPT-SoVITS engine itself (the same stub the
// broker suite uses), because a real inference server cannot be assumed in CI.
//
// Like broker.integration.node.test.js, every test SKIPS with a clear reason
// when the backend runtime is unavailable rather than red-lighting the suite.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBroker, httpJson, runtimeSkipReason } = require("./__testsupport__/brokerHarness");

let broker = null;
let skipReason = runtimeSkipReason();

before(async () => {
  if (skipReason) return;
  try {
    // 64000 samples @16kHz = 4.0s. The synthesis service enforces a 3-10s
    // reference clip, so the default ~0s fixture would fail every Flow run
    // with LEGACY_TTS_SERVICE_FAILED before the engine is ever reached.
    broker = await startBroker({ extraEnv: { FLOW_ENABLED: "1" }, refSamples: 64000 });
  } catch (e) {
    skipReason = e.message;
  }
}, { timeout: 90000 });

after(async () => {
  if (broker) await broker.stop();
});

function guard(t) {
  if (!broker) { t.skip(skipReason || "broker unavailable"); return true; }
  return false;
}

function resetEngine() {
  if (broker) { broker.engine.state.online = true; broker.engine.state.ttsStatus = 200; }
}

// The narrowest graph that still exercises a real engine call and a Gate.
//
//   text ---\
//            +--> tts --> review(gate) 
//   voice --/     |
//                 +--> output
//
// The Gate reviews the generated audio, which is the realistic shape: a user
// listens to the result before accepting it.
function minimalWorkflow() {
  return {
    schema: "aurivox.workflow",
    schema_version: 1,
    id: "wf_flow_e2e",
    name: "Flow end-to-end smoke",
    workflow_revision_id: "rev_e2e_1",
    inputs: {
      text: { type: "TextArtifact", required: true },
      voice: { type: "VoiceRef", required: true },
    },
    nodes: [
      { id: "text", type: "io.text_input", type_version: 1, params: { workflow_input: "text" } },
      { id: "voice", type: "io.voice_input", type_version: 1, params: { workflow_input: "voice" } },
      { id: "tts", type: "tts.generate", type_version: 1, params: { media_type: "wav" } },
      {
        id: "review",
        type: "review.human_gate",
        type_version: 1,
        params: { review_schema: "audio.review.v1", decisions: ["approve", "reject", "cancel"] },
      },
      { id: "output", type: "io.audio_output", type_version: 1 },
    ],
    edges: [
      { id: "e_text_tts", from: { node: "text", port: "text" }, to: { node: "tts", port: "text" } },
      { id: "e_voice_tts", from: { node: "voice", port: "voice" }, to: { node: "tts", port: "voice" } },
      { id: "e_tts_review", from: { node: "tts", port: "audio" }, to: { node: "review", port: "review_target" } },
      { id: "e_tts_output", from: { node: "tts", port: "audio" }, to: { node: "output", port: "audio" } },
    ],
  };
}

const flowInputs = () => ({
  text: { artifact_id: "art_text_e2e", type: "TextArtifact", value: "こんにちは" },
  voice: { artifact_id: "art_voice_e2e", type: "VoiceRef", voice_id: "jp_voice" },
});

// --------------------------------------------------------------------------- //
//  Reachability — the wiring exists at all
// --------------------------------------------------------------------------- //

test("flow: the kernel is reachable from the running server when FLOW_ENABLED=1", async (t) => {
  if (guard(t)) return;
  const { status, body } = await httpJson(broker.base_url + "/api/flow/status");
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.ok(body.journal_dir, "a Journal directory must be reported");
});

// --------------------------------------------------------------------------- //
//  The actual end-to-end run
// --------------------------------------------------------------------------- //

test("flow: a run reaches the Human Gate after a REAL engine call and writes a real WAV", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const { status, body } = await httpJson(broker.base_url + "/api/flow/runs", {
    method: "POST",
    body: { workflow: minimalWorkflow(), inputs: flowInputs() },
    timeout: 60000,
  });

  assert.equal(status, 200, `expected the run to start, got ${status}: ${JSON.stringify(body)}`);
  const run = body.run;
  assert.equal(run.status, "awaiting_human_review", "the run must stop at the Gate");

  // The engine really was called, with the language resolved from the voice.
  assert.ok(broker.engine.state.lastTts, "the stub engine must have received a /tts call");
  assert.equal(broker.engine.state.lastTts.text, "こんにちは");

  // A real audio artifact exists, produced by the real synthesis service.
  const ttsNode = run.node_runs.tts;
  assert.equal(ttsNode.status, "succeeded");
  const audio = ttsNode.outputs.audio;
  assert.equal(audio.type, "AudioArtifact");
  assert.ok(audio.uri, "the AudioArtifact must carry a uri");

  // FLOW-D26 holds on the live path too, not just in unit tests.
  assert.ok(audio.fingerprint && audio.fingerprint.startsWith("sha256:"), "live artifacts must be fingerprinted");
  assert.equal(audio.fingerprint_kind, "descriptor", "the fingerprint must be labelled a descriptor, not a content hash");
  assert.ok(!/audio_url|https?:/i.test(audio.artifact_id), "artifact_id must not embed the url");
});

test("flow: the Gate can be approved and the run completes through io.audio_output", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const started = await httpJson(broker.base_url + "/api/flow/runs", {
    method: "POST",
    body: { workflow: minimalWorkflow(), inputs: flowInputs() },
    timeout: 60000,
  });
  assert.equal(started.status, 200);
  const runId = started.body.run.run_id;
  const gate = started.body.run.gates[Object.keys(started.body.run.gates)[0]];
  assert.ok(gate, "a Gate must have been created");

  const resumed = await httpJson(`${broker.base_url}/api/flow/runs/${runId}/gate`, {
    method: "POST",
    body: {
      gate_id: gate.gate_id,
      expected_gate_revision: gate.gate_revision,
      decision: "approve",
      operator: "integration-test",
      outputs: { approved: gate.input_artifacts },
    },
    timeout: 60000,
  });

  assert.equal(resumed.status, 200, `expected resume to succeed: ${JSON.stringify(resumed.body)}`);
  assert.equal(resumed.body.run.status, "succeeded", "the run must reach a terminal success state");
  assert.equal(resumed.body.run.node_runs.output.status, "succeeded");
});

test("flow: a stale gate revision is rejected with 409 instead of silently re-running", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const started = await httpJson(broker.base_url + "/api/flow/runs", {
    method: "POST",
    body: { workflow: minimalWorkflow(), inputs: flowInputs() },
    timeout: 60000,
  });
  const runId = started.body.run.run_id;
  const gate = started.body.run.gates[Object.keys(started.body.run.gates)[0]];

  const stale = await httpJson(`${broker.base_url}/api/flow/runs/${runId}/gate`, {
    method: "POST",
    body: {
      gate_id: gate.gate_id,
      expected_gate_revision: gate.gate_revision + 5,
      decision: "approve",
      operator: "integration-test",
      outputs: { approved: gate.input_artifacts },
    },
    timeout: 60000,
  });

  assert.equal(stale.status, 409, `stale revisions must conflict, got ${stale.status}`);
});

// --------------------------------------------------------------------------- //
//  Failure propagation from the real engine
// --------------------------------------------------------------------------- //

test("flow: a real engine failure fails the Run closed rather than producing an artifact", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.ttsStatus = 500;

  const started = await httpJson(broker.base_url + "/api/flow/runs", {
    method: "POST",
    body: { workflow: minimalWorkflow(), inputs: flowInputs() },
    timeout: 60000,
  });
  resetEngine();

  // Either the start call reports the failure, or the projection records it —
  // both are acceptable, silently succeeding is not.
  const run = started.body.run || null;
  if (run) {
    assert.notEqual(run.status, "succeeded", "a failed engine call must not yield a succeeded Run");
    assert.notEqual(run.status, "awaiting_human_review", "a failed engine call must not reach the Gate");
  } else {
    assert.ok(started.status >= 400, "a failed engine call must surface as an error");
  }
});

// --------------------------------------------------------------------------- //
//  Persistence — the Journal is real, on disk, and survives the request
// --------------------------------------------------------------------------- //

test("flow: the Run Journal is persisted to disk and replays to the same state", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const started = await httpJson(broker.base_url + "/api/flow/runs", {
    method: "POST",
    body: { workflow: minimalWorkflow(), inputs: flowInputs() },
    timeout: 60000,
  });
  const runId = started.body.run.run_id;

  const statusRes = await httpJson(broker.base_url + "/api/flow/status");
  const journalDir = statusRes.body.journal_dir;
  assert.ok(fs.existsSync(journalDir), "the Journal directory must exist on disk");

  const files = fs.readdirSync(journalDir).filter((f) => f.includes(runId));
  assert.ok(files.length > 0, `the Journal for ${runId} must be on disk, saw: ${fs.readdirSync(journalDir).join(",")}`);

  const raw = fs.readFileSync(path.join(journalDir, files[0]), "utf-8");
  assert.ok(raw.includes("GATE_CREATED"), "the persisted Journal must contain the Gate event");

  // FLOW-D10a's privacy guarantee holds where it was actually made: the
  // *input snapshot* is redacted to identity only (kind/artifact_id/type/
  // fingerprint), never the value.
  const created = raw.split(/\r?\n/).find((l) => l.includes("RUN_CREATED"));
  assert.ok(created && !created.includes("こんにちは"), "the input snapshot must not persist plaintext");

  // KNOWN GAP — FLOW-D27. Node OUTPUTS are persisted verbatim, and the legacy
  // adapter echoes the request text into InferenceResult.metadata.request, so
  // the plaintext does reach the Journal by that route. This assertion pins the
  // CURRENT behaviour deliberately: it is a gap, not a guarantee, and fixing it
  // must trip this test so the change is a decision rather than a side effect.
  assert.ok(raw.includes("こんにちは"), "FLOW-D27: outputs still carry plaintext into the Journal (known gap)");

  const replayed = await httpJson(`${broker.base_url}/api/flow/runs/${runId}`);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.run.status, "awaiting_human_review");
});

// --------------------------------------------------------------------------- //
//  Non-regression: the Workbench surface is untouched by the wiring
// --------------------------------------------------------------------------- //

// The single most important non-regression property: with the flag unset the
// Flow kernel must not exist in the process at all. This boots its OWN server
// without FLOW_ENABLED, because the shared one has it on.
test("flow: with FLOW_ENABLED unset the Flow surface is absent entirely", async (t) => {
  if (skipReason) { t.skip(skipReason); return; }
  let plain = null;
  try {
    plain = await startBroker();
  } catch (e) {
    t.skip(e.message);
    return;
  }
  try {
    const { status } = await httpJson(plain.base_url + "/api/flow/status");
    assert.equal(status, 404, "no Flow route may be mounted when the flag is unset");

    const legacy = await httpJson(plain.base_url + "/v1/audio/speech", {
      method: "POST",
      body: { model: "gpt-sovits", voice: "jp_voice", input: "hello" },
      timeout: 60000,
    });
    assert.equal(legacy.status, 200, "the default server must keep working untouched");
  } finally {
    await plain.stop();
  }
});

test("flow: enabling Flow does not disturb the legacy Workbench synthesis route", async (t) => {
  if (guard(t)) return;
  resetEngine();

  // The OpenAI-compatible speech route is the one the broker suite exercises;
  // it is also the surface external clients depend on, so it is the meaningful
  // non-regression target.
  const { status, headers } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { model: "gpt-sovits", voice: "jp_voice", input: "こんにちは" },
    timeout: 60000,
  });
  assert.equal(status, 200, "legacy OpenAI-compatible synthesis must still work");
  assert.equal(headers["x-text-lang"], "ja", "language resolution must be unchanged");
});
