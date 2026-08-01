// Unit tests for the UVR5 model registry (Node built-in runner, no jest):
//     node --test lib/training/gsv-tools/uvr5/
//
// Contract under test (uvr5_models.js):
//   * normalizePipeline coerces legacy shapes, drops unknowns, clamps agg,
//     strips agg for non-VR models, and caps at MAX_PIPELINE_STAGES.
//   * installed/missing/catalogue reflect the on-disk weight files.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const uvr5 = require("./uvr5_models");

// Canonical stages now carry architecture-specific expert defaults. Most legacy
// tests only care about {model, agg}, so project stages down to those keys.
const core = (stages) => stages.map((s) => {
  const o = { model: s.model };
  if (s.agg != null) o.agg = s.agg;
  return o;
});

test("allIds includes the full official set (both Roformers)", () => {
  const ids = uvr5.allIds();
  for (const id of ["HP2", "HP3", "HP5", "MDX-Net", "DeEcho-Normal",
    "DeEcho-Aggressive", "DeEcho-DeReverb", "BS-Roformer", "Mel-Band-Roformer"]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
});

test("Mel-Band-Roformer: roformer arch, ckpt-only required, exposes roformer knobs", () => {
  const m = uvr5.getModel("Mel-Band-Roformer");
  assert.equal(m.arch, "roformer");
  assert.equal(m.aggApplicable, false);
  // No yaml needed (built-in default config) -> only the ckpt file.
  assert.deepEqual(m.files, ["MelBandRoformer.ckpt"]);
  assert.equal(m.weightArg, "MelBandRoformer.ckpt");
  const [s] = uvr5.normalizePipeline([{ model: "Mel-Band-Roformer", overlap: 4 }]);
  assert.equal(s.agg, undefined);
  assert.equal(s.overlap, 4);
  assert.equal(s.precision, "fp32");
});

test("normalizePipeline: legacy 'mdx-net' string -> HP2@10", () => {
  assert.deepEqual(core(uvr5.normalizePipeline("mdx-net")), [{ model: "HP2", agg: 10 }]);
});

test("normalizePipeline: legacy {model} object -> one stage", () => {
  assert.deepEqual(core(uvr5.normalizePipeline({ model: "HP5" })), [{ model: "HP5", agg: 10 }]);
});

test("normalizePipeline: agg clamped to [0,20], drops unknown model", () => {
  const out = uvr5.normalizePipeline([
    { model: "HP2", agg: 99 },
    { model: "NOPE" },
    { model: "DeEcho-Aggressive", agg: -5 },
  ]);
  assert.deepEqual(core(out), [
    { model: "HP2", agg: 20 },
    { model: "DeEcho-Aggressive", agg: 0 },
  ]);
});

test("normalizePipeline: MDX-Net (non-VR) never carries agg", () => {
  const out = uvr5.normalizePipeline([{ model: "MDX-Net", agg: 12 }]);
  assert.deepEqual(core(out), [{ model: "MDX-Net" }]);
});

test("expert params: VR stage carries tta/postprocess/highEnd/precision defaults", () => {
  const [s] = uvr5.normalizePipeline([{ model: "HP2" }]);
  assert.equal(s.precision, "fp32");
  assert.equal(s.tta, false);
  assert.equal(s.postprocess, false);
  assert.equal(s.highEnd, "mirroring");
  // Non-VR params must NOT leak onto a VR stage.
  assert.equal(s.chunks, undefined);
  assert.equal(s.overlap, undefined);
});

test("expert params: VR knobs are coerced/clamped and enums validated", () => {
  const [s] = uvr5.normalizePipeline([
    { model: "HP2", tta: "true", postprocess: 1, highEnd: "bogus", precision: "fp16" },
  ]);
  assert.equal(s.tta, true);
  assert.equal(s.postprocess, true);
  assert.equal(s.highEnd, "mirroring"); // invalid enum -> default
  assert.equal(s.precision, "fp16");
});

test("expert params: MDX exposes chunks+precision only (no agg/tta)", () => {
  const [s] = uvr5.normalizePipeline([{ model: "MDX-Net", chunks: 999, tta: true }]);
  assert.equal(s.agg, undefined);
  assert.equal(s.tta, undefined);
  assert.equal(s.chunks, 40); // clamped to max
  assert.equal(s.precision, "fp32");
});

test("expert params: Roformer exposes overlap/batchSize/precision only", () => {
  const [s] = uvr5.normalizePipeline([{ model: "BS-Roformer", overlap: 5, batchSize: 3 }]);
  assert.equal(s.agg, undefined);
  assert.equal(s.overlap, 5);
  assert.equal(s.batchSize, 3);
  assert.equal(s.precision, "fp32");
  assert.equal(s.highEnd, undefined);
});

test("catalogue exposes per-arch expertParams descriptors", () => {
  const cat = uvr5.catalogue(null);
  const vr = cat.find((m) => m.id === "HP2").expertParams.map((p) => p.key);
  assert.deepEqual(vr.sort(), ["highEnd", "postprocess", "precision", "tta"]);
  const mdx = cat.find((m) => m.id === "MDX-Net").expertParams.map((p) => p.key);
  assert.deepEqual(mdx.sort(), ["chunks", "precision"]);
  const rof = cat.find((m) => m.id === "BS-Roformer").expertParams.map((p) => p.key);
  assert.deepEqual(rof.sort(), ["batchSize", "overlap", "precision"]);
});

test("normalizePipeline: capped at MAX_PIPELINE_STAGES", () => {
  const many = Array.from({ length: 6 }, () => ({ model: "HP2" }));
  assert.equal(uvr5.normalizePipeline(many).length, uvr5.MAX_PIPELINE_STAGES);
});

test("normalizePipeline: {pipeline:[...]} wrapper is unwrapped", () => {
  const out = uvr5.normalizePipeline({ pipeline: [{ model: "HP3", agg: 7 }] });
  assert.deepEqual(core(out), [{ model: "HP3", agg: 7 }]);
});

test("installed/missing reflect on-disk files; catalogue annotates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-weights-"));
  try {
    assert.equal(uvr5.isInstalled(dir, "HP2"), false);
    assert.deepEqual(uvr5.missingFiles(dir, "HP2"), ["HP2_all_vocals.pth"]);

    fs.writeFileSync(path.join(dir, "HP2_all_vocals.pth"), "x");
    assert.equal(uvr5.isInstalled(dir, "HP2"), true);
    assert.deepEqual(uvr5.missingFiles(dir, "HP2"), []);

    // MDX-Net is a folder model (onnx_dereverb_By_FoxJoy/vocals.onnx).
    assert.equal(uvr5.isInstalled(dir, "MDX-Net"), false);
    fs.mkdirSync(path.join(dir, "onnx_dereverb_By_FoxJoy"), { recursive: true });
    fs.writeFileSync(path.join(dir, "onnx_dereverb_By_FoxJoy", "vocals.onnx"), "x");
    assert.equal(uvr5.isInstalled(dir, "MDX-Net"), true);

    const cat = uvr5.catalogue(dir);
    const hp2 = cat.find((m) => m.id === "HP2");
    assert.equal(hp2.installed, true);
    assert.equal(hp2.aggApplicable, true);
    const mdx = cat.find((m) => m.id === "MDX-Net");
    assert.equal(mdx.aggApplicable, false);
    assert.equal(mdx.arch, "mdx");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWeightArg: MDX points at the onnx FOLDER, VR at the .pth", () => {
  const dir = "/weights";
  assert.equal(uvr5.resolveWeightArg(dir, "MDX-Net"),
    path.join(dir, "onnx_dereverb_By_FoxJoy"));
  assert.equal(uvr5.resolveWeightArg(dir, "HP2"),
    path.join(dir, "HP2_all_vocals.pth"));
});
