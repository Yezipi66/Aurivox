// AURIVOX FLOW 的真实端到端集成测试。这条链路证明 Flow 内核在真实进程里可达：
// 真实 server.js -> /api/flow/runs -> FlowRuntime -> WorkflowExecutor -> legacySynthesis
// 适配器 -> 真实 synthesisService -> HTTP -> 引擎 -> 盘上真实 WAV -> 盘上 Journal
// -> 人工关卡 -> 批准
// 除 GPT-SoVITS 引擎本身（与 broker 测试同一份桩）外全程不替换：CI 里不能假定有真实
// 推理服务器。运行环境不可用时每条测试都带原因 skip，不把整套测试报红。

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

// 仍然会真调一次引擎、并且带一道关卡的最窄一张图：
//
//  text ---\
//  +--> tts --> review(gate)
//  voice --/ |
//  +--> output
//
// 关卡审的是生成出来的音频，这是真实形状：人先听一遍再决定收不收。
//
// 这张图有两条会红的链路，都必须避开：
//  · tts 节点不带 engine_id 时，legacySynthesis 适配器挑不出引擎，synthesisService 抛
//    「这次合成没说要用哪台引擎」，整条 run 变 failed。engine_id 只能走 tts 节点的 params，
//    那是这一套节点表里点名引擎的既有通道。
//  · 本仓库有两套互不相识的节点表：lib/flowgraph/nodes.js 有 io.engine 节点，
//    lib/workflow/nodeRegistry.js 没有。本文件走的是 lib/workflow/ 那一套，改 fixture
//    之前先确认它跑的是哪一套表：两套同名不同形的注册表，照着另一份文档改必然出错。
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
      //  平台不替谁挑一台默认引擎，所以这张图必须自己点名。这里写死 gpt-sovits 是对的：
      //  brokerHarness 起的就是那台的桩，端到端测试必须知道自己在打谁。
      { id: "tts", type: "tts.generate", type_version: 1, params: { media_type: "wav", engine_id: "gpt-sovits" } },
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

// Reachability — the wiring exists at all

test("flow: the kernel is reachable from the running server when FLOW_ENABLED=1", async (t) => {
  if (guard(t)) return;
  const { status, body } = await httpJson(broker.base_url + "/api/flow/status");
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.ok(body.journal_dir, "a Journal directory must be reported");
});

// The actual end-to-end run

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

// Failure propagation from the real engine

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

  // Either the start call reports the failure, or the projection records it; both are
  // acceptable, silently succeeding is not.
  const run = started.body.run || null;
  if (run) {
    assert.notEqual(run.status, "succeeded", "a failed engine call must not yield a succeeded Run");
    assert.notEqual(run.status, "awaiting_human_review", "a failed engine call must not reach the Gate");
  } else {
    assert.ok(started.status >= 400, "a failed engine call must surface as an error");
  }
});

// Persistence — the Journal is real, on disk, and survives the request

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

  // FLOW-D10a's privacy guarantee holds where it was actually made: the *input snapshot* is
  // redacted to identity only (kind/artifact_id/type/fingerprint), never the value.
  const created = raw.split(/\r?\n/).find((l) => l.includes("RUN_CREATED"));
  assert.ok(created && !created.includes("こんにちは"), "the input snapshot must not persist plaintext");

  // FLOW-D27 stage 2 (channel 1 + channel 2). Journal-safe outputs (§4.8.1) pass through
  // verbatim; the synth node's output is not journal-safe (metadata sits outside the identity
  // allowlist), so both the text output and the adapter's metadata echo are reduced to digests.
  // 仍未修好的两处不在 stage 2 的范围内：channel 2 的源头（适配器仍在内存里组装
  // metadata.request.text，去掉的只是它落 Journal 的那一份）；channel 3（GATE_CREATED 的
  // 审阅载荷是另外追加的，形状随图而变，这一刀没有动它）。FLOW-D27 仍然是开着的。
  assert.ok(
    !raw.includes("こんにちは"),
    "FLOW-D27 stage 2: NODE_SUCCEEDED outputs must no longer carry plaintext into the Journal",
  );

  const replayed = await httpJson(`${broker.base_url}/api/flow/runs/${runId}`);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.run.status, "awaiting_human_review");
});

// Non-regression: the Workbench surface is untouched by the wiring

// The single most important non-regression property: with the flag unset the Flow kernel must not
// exist in the process at all. This boots its OWN server without FLOW_ENABLED (the shared one has
// it on).
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
      // 契约 §12 第 2 步：裸音色名（非 "role/name" 配方）现在必须自带 engine_id。
      // model:"gpt-sovits" 在给了 voice 时是死字段，不是引擎选择。
      body: { model: "gpt-sovits", voice: "jp_voice", input: "hello", engine_id: "gpt-sovits" },
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

  // The OpenAI-compatible speech route is the one the broker suite exercises; it is also the
  // surface external clients depend on, so it is the meaningful non-regression target.

  const { status, headers } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    // 契约 §12 第 2 步：裸音色名要带 engine_id。
    // model:"gpt-sovits" 在给了 voice 时是死字段，不是引擎选择。
    body: { model: "gpt-sovits", voice: "jp_voice", input: "こんにちは", engine_id: "gpt-sovits" },
    timeout: 60000,
  });
  assert.equal(status, 200, "legacy OpenAI-compatible synthesis must still work");
  assert.equal(headers["x-text-lang"], "ja", "language resolution must be unchanged");
});
