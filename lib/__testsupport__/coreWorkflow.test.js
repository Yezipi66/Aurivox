// ===========================================================================
//  CORE WORKFLOW — REAL END-TO-END SMOKE TEST
// ===========================================================================
// 这组测试启动真实的 server.js，按用户实际操作顺序验证核心工作流。
//
// Run: node --test lib/__testsupport__/coreWorkflow.test.js
// ===========================================================================

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startBroker, httpJson, runtimeSkipReason, minimalWav } = require("./brokerHarness");

let broker = null;
let skipReason = runtimeSkipReason();

function isValidWav(buf) {
  if (!buf || buf.length < 44) return false;
  return (
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE" &&
    buf.toString("ascii", 12, 16) === "fmt "
  );
}

function wavInfo(buf) {
  if (!isValidWav(buf)) return null;
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataSize = buf.readUInt32LE(40);
  return { channels, sampleRate, bitsPerSample, dataSize, durationSec: dataSize / (sampleRate * channels * (bitsPerSample / 8)) };
}

before(async () => {
  if (skipReason) return;
  try {
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

// ===========================================================================
//  1. 健康检查
// ===========================================================================
test("[CORE] health endpoint returns complete shape", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/health");
  assert.equal(status, 200);
  for (const key of ["ok", "engine_online", "gpt_sovits_url", "ffmpeg_available", "cuda", "version"]) {
    assert.ok(key in body, `missing health field: ${key}`);
  }
  assert.equal(body.ok, true);
  assert.equal(body.engine_online, true);
  assert.equal(body.gpt_sovits_url.replace(/\/+$/, ""), broker.engine.url.replace(/\/+$/, ""));
  assert(typeof body.version === "string" && body.version.length > 0, "version must be a non-empty string");
  console.log(`  health: version=${body.version}, engine_online=${body.engine_online}, ffmpeg=${body.ffmpeg_available}`);
});

// ===========================================================================
//  2. 列出音色
// ===========================================================================
test("[CORE] voices list endpoint returns fixture voices", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/voices");
  assert.equal(status, 200);
  assert(Array.isArray(body.voices), "voices must be an array");
  const ids = body.voices.map(v => v.id);
  assert.ok(ids.includes("novoice_lang"), `missing fixture voice 'novoice_lang'; got: ${ids.join(", ")}`);
  assert.ok(ids.includes("jp_voice"), `missing fixture voice 'jp_voice'; got: ${ids.join(", ")}`);
  const base = body.voices.find(v => v.builtin === true);
  assert.ok(base, "missing built-in base voice");
  console.log(`  voices listed: ${body.voices.length} total`);
});

// ===========================================================================
//  3. 音色验证
// ===========================================================================
test("[CORE] voice validation endpoint works for fixture voices", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/voices/jp_voice/validate");
  assert.equal(status, 200);
  assert.equal(body.voice, "jp_voice");
  assert.ok("checks" in body, "validation response must have 'checks' field");
  const { checks } = body;
  assert.equal(checks.gpt_model_exists, false, "fixture has no gpt models");
  assert.equal(checks.sovits_model_exists, false, "fixture has no sovits models");
  assert.equal(checks.reference_audio_exists, true, "fixture reference audio should exist");
  assert.equal(checks.reference_text_present, true, "fixture reference text should be present");
  console.log("  voice validation: all checks passed");
});

// ===========================================================================
//  4. OpenAI 兼容语音合成 — 校验 WAV 响应
// ===========================================================================
test("[CORE] speech endpoint returns valid WAV audio", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers, body } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { model: "gpt-sovits", voice: "jp_voice", input: "こんにちは、世界" },
    timeout: 60000,
  });
  assert.equal(status, 200, `speech failed: ${status}`);
  const ctype = headers["content-type"] || "";
  assert.ok(ctype.includes("audio/"), `expected audio content-type, got: ${ctype}`);
  assert.ok(body instanceof Uint8Array, "response body must be binary (Uint8Array)");
  const buf = Buffer.from(body);
  assert.ok(isValidWav(buf), "response body must be a valid WAV file");
  const info = wavInfo(buf);
  assert.ok(info, "could not parse WAV header");
  assert.equal(info.channels, 1, "WAV must be mono");
  assert.equal(info.sampleRate, 16000, "WAV must be 16kHz");
  console.log(`  speech WAV: ${info.channels}ch, ${info.sampleRate}Hz, ${info.bitsPerSample}bit, ${info.durationSec.toFixed(2)}s, ${info.dataSize} bytes`);
});

// ===========================================================================
//  5. 语言防御 — 无语言元数据的音色
// ===========================================================================
test("[CORE] speech for language-less voice returns X-Language-Warning", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, headers } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { voice: "novoice_lang", input: "hello world" },
    timeout: 60000,
  });
  assert.equal(status, 200);
  assert.equal(headers["x-text-lang"], "auto");
  assert.ok(headers["x-language-warning"], "missing X-Language-Warning for language-less voice");
  console.log(`  language defense: X-Language-Warning="${headers["x-language-warning"]}"`);
});

// ===========================================================================
//  6. 请求语言覆盖
// ===========================================================================
test("[CORE] speech with explicit language override works", async (t) => {
  if (guard(t)) return;
  resetEngine();
  broker.engine.state.lastTts = null;
  const { status, headers } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { voice: "jp_voice", input: "hello", language: "en" },
    timeout: 60000,
  });
  assert.equal(status, 200);
  assert.equal(headers["x-text-lang"], "en", "request language must override voice language");
  const payload = broker.engine.state.lastTts;
  assert.ok(payload, "engine must have received a /tts payload");
  assert.equal(payload.text_lang, "en", "language override must reach engine");
  console.log("  language override: en -> text_lang=en");
});

// ===========================================================================
//  7. 遗留生成接口 /api/generate
// ===========================================================================
test("[CORE] legacy generate endpoint returns JSON with audio_url", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/generate", {
    method: "POST",
    body: { voice: "jp_voice", text: "テスト" },
    timeout: 60000,
  });
  assert.equal(status, 200, `generate failed: ${status}`);
  assert.equal(typeof body, "object", "generate response must be JSON");
  assert.ok(body.ok !== undefined, "response must have 'ok' field");
  assert.equal(body.ok, true, "generate must succeed");
  assert.ok(body.audio_url || (body.files && body.files.length > 0), "generate response must contain audio_url or files");
  const url = body.audio_url || (body.files && body.files[0] && body.files[0].url);
  assert.ok(url, "could not determine audio URL from response");
  console.log(`  generate: audio_url=${url}`);
});

// ===========================================================================
//  8. 模型状态
// ===========================================================================
test("[CORE] model status endpoint returns version info for v2/v2Pro/v2ProPlus", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status, body } = await httpJson(broker.base_url + "/api/models/status?versions=v2,v2Pro,v2ProPlus");
  assert.equal(status, 200);
  assert(Array.isArray(body.versions), "versions must be an array");
  assert.equal(body.versions.length, 3, "must have 3 version entries");
  const versions = body.versions.map(v => v.version);
  assert.ok(versions.includes("v2"), "v2 must be present");
  assert.ok(versions.includes("v2Pro"), "v2Pro must be present");
  assert.ok(versions.includes("v2ProPlus"), "v2ProPlus must be present");
  for (const v of body.versions) {
    assert.ok(v.ok !== undefined, `${v.version} must have ok field`);
    console.log(`  model status: ${v.version}, ok=${v.ok}, blocking=${v.blocking}, degraded=${v.degraded}`);
  }
});

// ===========================================================================
//  9. 语音 CRUD 生命周期
// ===========================================================================
test("[CORE] VOICE CRUD: create, read, update, delete", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const create = await httpJson(broker.base_url + "/api/voices", {
    method: "POST",
    body: { id: "test_crud_voice", display_name: "CRUD Test Voice", language: "ja" },
    timeout: 10000,
  });
  assert.equal(create.status, 200, `create voice failed: ${create.status}`);
  assert.equal(create.body.ok, true);
  assert.equal(create.body.id, "test_crud_voice");
  console.log("  CRUD: created voice 'test_crud_voice'");

  const list = await httpJson(broker.base_url + "/api/voices");
  const ids = list.body.voices.map(v => v.id);
  assert.ok(ids.includes("test_crud_voice"), "created voice must appear in list");

  const full = await httpJson(broker.base_url + "/api/voices/full");
  assert.ok(full.body.voices["test_crud_voice"], "created voice must be in full voice list");
  assert.equal(full.body.voices["test_crud_voice"].display_name, "CRUD Test Voice");

  const update = await httpJson(broker.base_url + "/api/voices/test_crud_voice", {
    method: "PUT",
    body: { display_name: "Updated CRUD Voice", language: "en" },
    timeout: 10000,
  });
  assert.equal(update.status, 200, `update voice failed: ${update.status}`);
  assert.equal(update.body.voice.display_name, "Updated CRUD Voice");
  console.log("  CRUD: updated voice language to en");

  const del = await httpJson(broker.base_url + "/api/voices/test_crud_voice", {
    method: "DELETE",
    timeout: 10000,
  });
  assert.equal(del.status, 200, `delete voice failed: ${del.status}`);
  assert.equal(del.body.ok, true);

  const listAfter = await httpJson(broker.base_url + "/api/voices");
  const idsAfter = listAfter.body.voices.map(v => v.id);
  assert.ok(!idsAfter.includes("test_crud_voice"), "deleted voice must not appear in list");
  console.log("  CRUD: deleted voice successfully");
});

// ===========================================================================
//  10. FLOW 内核 — 完整端到端
// ===========================================================================
test("[CORE] FLOW: full end-to-end run with gate approval", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const statusRes = await httpJson(broker.base_url + "/api/flow/status");
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.enabled, true, "FLOW must be enabled with FLOW_ENABLED=1");
  assert.ok(statusRes.body.journal_dir, "journal_dir must be reported");

  const workflow = {
    schema: "aurivox.workflow",
    schema_version: 1,
    id: "wf_core_test",
    name: "Core workflow test",
    workflow_revision_id: "rev_core_1",
    inputs: {
      text: { type: "TextArtifact", required: true },
      voice: { type: "VoiceRef", required: true },
    },
    nodes: [
      { id: "text", type: "io.text_input", type_version: 1, params: { workflow_input: "text" } },
      { id: "voice", type: "io.voice_input", type_version: 1, params: { workflow_input: "voice" } },
      { id: "tts", type: "tts.generate", type_version: 1, params: { media_type: "wav" } },
      {
        id: "review", type: "review.human_gate", type_version: 1,
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

  const inputs = {
    text: { artifact_id: "art_text_core", type: "TextArtifact", value: "こんにちは、世界" },
    voice: { artifact_id: "art_voice_core", type: "VoiceRef", voice_id: "jp_voice" },
  };

  const started = await httpJson(broker.base_url + "/api/flow/runs", {
    method: "POST",
    body: { workflow, inputs },
    timeout: 60000,
  });
  assert.equal(started.status, 200, `flow run start failed: ${JSON.stringify(started.body)}`);
  const run = started.body.run;
  assert.equal(run.status, "awaiting_human_review", "run must stop at the Gate");
  assert.ok(run.run_id, "run must have a run_id");
  console.log(`  FLOW: run started, id=${run.run_id}, status=${run.status}`);

  assert.ok(broker.engine.state.lastTts, "engine must have received a /tts call");
  assert.equal(broker.engine.state.lastTts.text, "こんにちは、世界");

  const ttsNode = run.node_runs.tts;
  assert.equal(ttsNode.status, "succeeded");
  const audio = ttsNode.outputs.audio;
  assert.equal(audio.type, "AudioArtifact");
  assert.ok(audio.uri, "AudioArtifact must carry a URI");
  assert.ok(audio.fingerprint, "AudioArtifact must be fingerprinted");
  console.log(`  FLOW: audio artifact at ${audio.uri}, fingerprint=${audio.fingerprint.slice(0, 20)}...`);

  const gate = run.gates[Object.keys(run.gates)[0]];
  assert.ok(gate, "at least one Gate must be created");
  const resumed = await httpJson(`${broker.base_url}/api/flow/runs/${run.run_id}/gate`, {
    method: "POST",
    body: {
      gate_id: gate.gate_id,
      expected_gate_revision: gate.gate_revision,
      decision: "approve",
      operator: "core-workflow-test",
      outputs: { approved: gate.input_artifacts },
    },
    timeout: 60000,
  });
  assert.equal(resumed.status, 200, `gate approval failed: ${JSON.stringify(resumed.body)}`);
  assert.equal(resumed.body.run.status, "succeeded", "run must reach terminal state");
  assert.equal(resumed.body.run.node_runs.output.status, "succeeded");
  console.log("  FLOW: gate approved, run completed successfully");

  const journalDir = statusRes.body.journal_dir;
  assert.ok(fs.existsSync(journalDir), "journal directory must exist on disk");
  const files = fs.readdirSync(journalDir).filter(f => f.includes(run.run_id));
  assert.ok(files.length > 0, `journal for ${run.run_id} must be on disk`);
  console.log(`  FLOW: journal persisted (${files.length} files)`);
});

// ===========================================================================
//  11. 错误处理
// ===========================================================================
test("[CORE] speech with unknown voice returns 404", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { voice: "definitely_not_a_real_voice", input: "hi" },
    timeout: 10000,
  });
  assert.equal(status, 404, "unknown voice must return 404");
});

test("[CORE] speech with missing voice is 400", async (t) => {
  if (guard(t)) return;
  const { status, body } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { input: "hi" },
    timeout: 10000,
  });
  assert.equal(status, 400);
  assert(!!body?.error || !!body?.message, "error response must have message");
});

test("[CORE] speech with missing input is 400", async (t) => {
  if (guard(t)) return;
  const { status, body } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { voice: "jp_voice" },
    timeout: 10000,
  });
  assert.equal(status, 400);
  assert(!!body?.error || !!body?.message, "error response must have message");
});

// ===========================================================================
//  12. 非回归 — 未启用 FLOW 时不影响遗留 API
// ===========================================================================
test("[CORE] non-regression: server without FLOW_ENABLED still serves legacy API", async (t) => {
  if (skipReason) { t.skip(skipReason); return; }

  let plain = null;
  try {
    plain = await startBroker();
  } catch (e) {
    t.skip(e.message);
    return;
  }

  try {
    const health = await httpJson(plain.base_url + "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const speech = await httpJson(plain.base_url + "/v1/audio/speech", {
      method: "POST",
      body: { model: "gpt-sovits", voice: "jp_voice", input: "hello" },
      timeout: 30000,
    });
    assert.equal(speech.status, 200, "legacy speech must work without FLOW_ENABLED");
    assert.ok(speech.body instanceof Uint8Array, "speech response must be binary");

    const flow = await httpJson(plain.base_url + "/api/flow/status");
    assert.equal(flow.status, 404, "flow routes must not exist without FLOW_ENABLED");

    console.log("  non-regression: legacy API works without FLOW");
  } finally {
    await plain.stop();
  }
});

// ===========================================================================
//  13. 流式合成（streaming）— 期望 stub 引擎不支持时优雅降级
// ===========================================================================
test("[CORE] streaming speech request is accepted (stub may not support streaming)", async (t) => {
  if (guard(t)) return;
  resetEngine();

  const { status, headers, body } = await httpJson(broker.base_url + "/v1/audio/speech", {
    method: "POST",
    body: { voice: "jp_voice", input: "hello", stream: true, response_format: "wav" },
    timeout: 30000,
  });
  // 无论 stub 引擎是否支持 streaming，都不能是 500
  assert.ok(status < 500, `streaming must not crash server; got ${status}`);
  if (status === 200) {
    assert.ok(body instanceof Uint8Array, "streaming response must be binary");
    const buf = Buffer.from(body);
    assert.ok(buf.length > 0, "streaming response must not be empty");
    console.log(`  streaming: received ${buf.length} bytes (status 200)`);
  } else {
    console.log(`  streaming: status=${status} (stub may not support streaming)`);
  }
});

// ===========================================================================
//  14. flowgraph 是 opt-in：默认不开启
// ===========================================================================
test("[CORE] flowgraph is opt-in: returns 404 when FLOWGRAPH_ENABLED is not set", async (t) => {
  if (guard(t)) return;
  resetEngine();
  const { status } = await httpJson(broker.base_url + "/api/flowgraph/status");
  assert.equal(status, 404, "flowgraph routes must be absent when FLOWGRAPH_ENABLED is not set");
  console.log("  flowgraph: opt-in confirmed (404 when not enabled)");
});