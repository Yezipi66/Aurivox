// Unit tests for the multi-stage vocal-extraction orchestration (denoise.js).
//     node --test lib/training/steps/
//
// We stub spawn_async + python_helper via the require cache BEFORE loading
// denoise.js, so no Python/GPU/weights are needed. The stub records each uvr5_cli
// invocation and writes a dummy vocal file into the stage's --output dir, letting
// us assert: stage chaining (stage N's output feeds N+1), agg only for VR models,
// legacy {model} coercion, and the actionable missing-weight error.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DENOISE = path.join(__dirname, "denoise.js");
const SPAWN = path.join(__dirname, "spawn_async.js");
const PYHELP = path.join(__dirname, "..", "python_helper.js");

// Shared recorder for spawn calls across a test.
let SPAWN_CALLS = [];
function installStubs() {
  delete require.cache[require.resolve(DENOISE)];
  require.cache[require.resolve(SPAWN)] = {
    id: require.resolve(SPAWN), filename: require.resolve(SPAWN), loaded: true,
    exports: {
      spawnAsync: async (cmd, args) => {
        const oi = args.indexOf("--output");
        const outDir = args[oi + 1];
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, "vocal_out.wav"), "x");
        const mi = args.indexOf("--model");
        const ai = args.indexOf("--agg");
        const ii = args.indexOf("--input");
        const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
        SPAWN_CALLS.push({
          model: args[mi + 1], input: args[ii + 1], output: outDir,
          agg: ai >= 0 ? args[ai + 1] : null,
          args,
          tta: flag("--tta"), postprocess: flag("--postprocess"),
          highEnd: flag("--high-end"), isHalf: flag("--is_half"),
          chunks: flag("--chunks"), overlap: flag("--overlap"),
          batchSize: flag("--batch-size"),
        });
        return { status: 0, stdout: "ok", stderr: "" };
      },
    },
  };
  require.cache[require.resolve(PYHELP)] = {
    id: require.resolve(PYHELP), filename: require.resolve(PYHELP), loaded: true,
    exports: {
      getPythonPath: () => process.execPath, // exists on disk
      getCleanEnv: () => ({}),
    },
  };
  return require(DENOISE);
}

function makeWeights(ids) {
  const uvr5 = require("../gsv-tools/uvr5/uvr5_models");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-w-"));
  for (const id of ids) {
    for (const rel of uvr5.getModel(id).files) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    }
  }
  return dir;
}

function makeInput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-in-"));
  fs.writeFileSync(path.join(dir, "clip.wav"), "x");
  return dir;
}

function ctxFor(inputDir, weightsDir, pipeline) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-work-"));
  return {
    inputDir, workDir,
    config: { uvr5WeightsDir: weightsDir, steps: { denoise: { params: { pipeline } } } },
  };
}

test("two-stage chain: MDX-Net -> DeEcho-Aggressive feeds outputs forward", async () => {
  SPAWN_CALLS = [];
  const denoise = installStubs();
  const inputDir = makeInput();
  const weightsDir = makeWeights(["MDX-Net", "DeEcho-Aggressive"]);
  const ctx = ctxFor(inputDir, weightsDir,
    [{ model: "MDX-Net" }, { model: "DeEcho-Aggressive", agg: 10 }]);

  const res = await denoise.run(ctx, () => {});

  assert.equal(SPAWN_CALLS.length, 2);
  // Stage 1 reads the original input; stage 2 reads stage 1's output.
  assert.equal(SPAWN_CALLS[0].input, inputDir);
  assert.equal(SPAWN_CALLS[1].input, SPAWN_CALLS[0].output);
  // Last stage writes into workDir/denoise (the final product dir).
  assert.equal(SPAWN_CALLS[1].output, path.join(ctx.workDir, "denoise"));
  // MDX has no agg; DeEcho carries agg=10.
  assert.equal(SPAWN_CALLS[0].agg, null);
  assert.equal(SPAWN_CALLS[1].agg, "10");
  assert.ok(res.fileCount >= 1);

  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.rmSync(weightsDir, { recursive: true, force: true });
  fs.rmSync(ctx.workDir, { recursive: true, force: true });
});

test("expert params: VR stage emits tta/postprocess/high-end/is_half; MDX only chunks", async () => {
  SPAWN_CALLS = [];
  const denoise = installStubs();
  const inputDir = makeInput();
  const weightsDir = makeWeights(["MDX-Net", "HP2"]);
  const ctx = ctxFor(inputDir, weightsDir, [
    { model: "MDX-Net", chunks: 20, tta: true },              // tta must be stripped for MDX
    { model: "HP2", agg: 6, tta: true, postprocess: true, highEnd: "bypass", precision: "fp16" },
  ]);

  await denoise.run(ctx, () => {});
  const [mdx, vr] = SPAWN_CALLS;

  // MDX: chunks emitted, no VR-only flags, no agg.
  assert.equal(mdx.chunks, "20");
  assert.equal(mdx.tta, null);
  assert.equal(mdx.agg, null);
  assert.equal(mdx.isHalf, "false"); // precision default fp32 -> --is_half false

  // VR: full expert set emitted.
  assert.equal(vr.agg, "6");
  assert.equal(vr.tta, "true");
  assert.equal(vr.postprocess, "true");
  assert.equal(vr.highEnd, "bypass");
  assert.equal(vr.isHalf, "true"); // fp16
  assert.equal(vr.chunks, null);   // MDX-only, not on VR

  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.rmSync(weightsDir, { recursive: true, force: true });
  fs.rmSync(ctx.workDir, { recursive: true, force: true });
});

test("legacy {model:'mdx-net'} params coerce to a single HP2 stage", async () => {
  SPAWN_CALLS = [];
  const denoise = installStubs();
  const inputDir = makeInput();
  const weightsDir = makeWeights(["HP2"]);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-work-"));
  // No pipeline key — only the legacy `model` string.
  const ctx = {
    inputDir, workDir,
    config: { uvr5WeightsDir: weightsDir, steps: { denoise: { params: { model: "mdx-net" } } } },
  };

  await denoise.run(ctx, () => {});
  assert.equal(SPAWN_CALLS.length, 1);
  assert.match(SPAWN_CALLS[0].model, /HP2_all_vocals\.pth$/);
  assert.equal(SPAWN_CALLS[0].agg, "10");

  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.rmSync(weightsDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

test("missing weight -> actionable error naming the file + how to get it", async () => {
  SPAWN_CALLS = [];
  const denoise = installStubs();
  const inputDir = makeInput();
  const weightsDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-empty-")); // nothing installed
  const ctx = ctxFor(inputDir, weightsDir, [{ model: "HP2", agg: 10 }]);

  await assert.rejects(() => denoise.run(ctx, () => {}), (err) => {
    assert.match(err.message, /not installed/);
    assert.match(err.message, /HP2_all_vocals\.pth/);
    assert.match(err.message, /download_uvr5\.py/);
    return true;
  });
  assert.equal(SPAWN_CALLS.length, 0); // never spawned

  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.rmSync(weightsDir, { recursive: true, force: true });
  fs.rmSync(ctx.workDir, { recursive: true, force: true });
});

test("empty pipeline (enabled but nothing valid) throws a clear error", async () => {
  const denoise = installStubs();
  const inputDir = makeInput();
  const weightsDir = makeWeights([]);
  const ctx = ctxFor(inputDir, weightsDir, [{ model: "NOPE" }]);
  await assert.rejects(() => denoise.run(ctx, () => {}), /no valid model pipeline/);
  fs.rmSync(inputDir, { recursive: true, force: true });
  fs.rmSync(weightsDir, { recursive: true, force: true });
  fs.rmSync(ctx.workDir, { recursive: true, force: true });
});
