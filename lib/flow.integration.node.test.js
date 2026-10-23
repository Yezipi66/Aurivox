// Flow 内核的端到端集成测试：真实 server.js 起来，走 /api/flow/runs 到 FlowRuntime、
// WorkflowExecutor、legacySynthesis 适配器与真实 synthesisService，最后落到引擎、
// 盘上真实 WAV 与盘上 Journal，再经过人工关卡与批准。
// 除引擎本身用桩以外全程不替换：测试环境不假定有真实推理服务器。
// 运行环境不可用时每条测试都带原因 skip，不把整套测试报红。

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
    // 64000 samples @16kHz = 4.0s。合成服务要求参考音频 3 到 10 秒，
    // 默认那份约 0 秒的夹具会让每次 Flow 运行都在碰到引擎之前就以
    // LEGACY_TTS_SERVICE_FAILED 失败。
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

// 最窄的一张图：仍然会真调一次引擎，并且带一道关卡。
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

// 可达性：接线确实存在

test("flow: the kernel is reachable from the running server when FLOW_ENABLED=1", async (t) => {
  if (guard(t)) return;
  const { status, body } = await httpJson(broker.base_url + "/api/flow/status");
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.ok(body.journal_dir, "a Journal directory must be reported");
});

// 真正的端到端运行

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

  // 引擎确实被调到了，语种由音色解析而来。
  assert.ok(broker.engine.state.lastTts, "the stub engine must have received a /tts call");
  assert.equal(broker.engine.state.lastTts.text, "こんにちは");

  // 真实合成服务产出的真实音频产物。
  const ttsNode = run.node_runs.tts;
  assert.equal(ttsNode.status, "succeeded");
  const audio = ttsNode.outputs.audio;
  assert.equal(audio.type, "AudioArtifact");
  assert.ok(audio.uri, "the AudioArtifact must carry a uri");

  // 合成适配器产出的 artifact 必须带描述符指纹，artifact_id 不得从音频 URL 派生；真实链路上同样要成立。
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

// 真实引擎的失败如何传播

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

  // 启动调用报出失败，或投影记录下失败，两者都可以接受，
  // 悄悄成功不行。
  const run = started.body.run || null;
  if (run) {
    assert.notEqual(run.status, "succeeded", "a failed engine call must not yield a succeeded Run");
    assert.notEqual(run.status, "awaiting_human_review", "a failed engine call must not reach the Gate");
  } else {
    assert.ok(started.status >= 400, "a failed engine call must surface as an error");
  }
});

// 持久化：Journal 是真的，在盘上，并且能跨请求存活

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

  // 输入快照只留身份信息（kind / artifact_id / type / fingerprint），不留值。
  const created = raw.split(/\r?\n/).find((l) => l.includes("RUN_CREATED"));
  assert.ok(created && !created.includes("こんにちは"), "the input snapshot must not persist plaintext");

  // 节点输出只有全部字段都在身份白名单内时才原样写进 Journal；合成节点的输出带 metadata，
  // 不满足，所以文本输出与适配器回显的 metadata 都只留摘要。
  // 尚未覆盖的两处：适配器仍在内存里组装 metadata.request.text（只是不再落 Journal）；
  // GATE_CREATED 的审阅载荷另外追加、形状随图而变，没有做缩减。
  assert.ok(
    !raw.includes("こんにちは"),
    "FLOW-D27 stage 2: NODE_SUCCEEDED outputs must no longer carry plaintext into the Journal",
  );

  const replayed = await httpJson(`${broker.base_url}/api/flow/runs/${runId}`);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.run.status, "awaiting_human_review");
});

// 非回归：接上线之后，Workbench 界面不动

// 最关键的一条非回归性质：不设开关时，Flow 内核在进程里根本不该存在。
// 这条自己起一个不带 FLOW_ENABLED 的服务器（共享那个开着）。
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
      // 裸音色名（非 "role/name" 配方）必须自带 engine_id。
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

  // OpenAI 兼容的语音路由是 broker 测试覆盖的那一条，
  // 也是外部客户端依赖的界面，所以它才是有意义的非回归目标。

  const { status, headers } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    // 裸音色名必须带 engine_id。
    // model:"gpt-sovits" 在给了 voice 时是死字段，不是引擎选择。
    body: { model: "gpt-sovits", voice: "jp_voice", input: "こんにちは", engine_id: "gpt-sovits" },
    timeout: 60000,
  });
  assert.equal(status, 200, "legacy OpenAI-compatible synthesis must still work");
  assert.equal(headers["x-text-lang"], "ja", "language resolution must be unchanged");
});
