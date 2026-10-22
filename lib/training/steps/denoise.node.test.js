// 人声提取（denoise.js）多级编排的单元测试。
// 运行方式：node --test lib/training/steps/
//
// 加载 denoise.js 之前先在 require 缓存里替换 spawn_async 与 python_helper，
// 所以不需要 Python、显卡与权重。替身记录每次 uvr5_cli 调用，并在该级的 --output
// 目录里写一个占位人声文件，据此断言：级的串联（第 N 级的输出喂给第 N+1 级）、
// 只有 VR 系模型带 agg、老式 {model} 参数的归一，以及缺权重时报出的可执行错误。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DENOISE = path.join(__dirname, "denoise.js");
const SPAWN = path.join(__dirname, "spawn_async.js");
const PYHELP = path.join(__dirname, "..", "python_helper.js");

// 记录 spawn 调用，供各个测试共用。
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
      getPythonPath: () => process.execPath, // 磁盘上确实存在
      getCleanEnv: () => ({}),
    },
  };
  return require(DENOISE);
}

function makeWeights(ids) {
  const uvr5 = require("../../../pipeline/uvr5/uvr5_models");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-w-"));
  for (const id of ids) {
    for (const rel of uvr5.modelFiles(id)) {
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
  // 第 1 级读原始输入，第 2 级读第 1 级的输出。
  assert.equal(SPAWN_CALLS[0].input, inputDir);
  assert.equal(SPAWN_CALLS[1].input, SPAWN_CALLS[0].output);
  // 最后一级写进 workDir/denoise（最终产物目录）。
  assert.equal(SPAWN_CALLS[1].output, path.join(ctx.workDir, "denoise"));
  // MDX 不带 agg，DeEcho 带 agg=10。
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
    { model: "MDX-Net", chunks: 20, tta: true },              // MDX 不接受 tta，要剥掉
    { model: "HP2", agg: 6, tta: true, postprocess: true, highEnd: "bypass", precision: "fp16" },
  ]);

  await denoise.run(ctx, () => {});
  const [mdx, vr] = SPAWN_CALLS;

  // MDX：只发 chunks，没有 VR 专有参数，也没有 agg。
  assert.equal(mdx.chunks, "20");
  assert.equal(mdx.tta, null);
  assert.equal(mdx.agg, null);
  assert.equal(mdx.isHalf, "false"); // 精度默认 fp32，所以 --is_half 为 false

  // VR：发全套专家参数。
  assert.equal(vr.agg, "6");
  assert.equal(vr.tta, "true");
  assert.equal(vr.postprocess, "true");
  assert.equal(vr.highEnd, "bypass");
  assert.equal(vr.isHalf, "true"); // fp16
  assert.equal(vr.chunks, null);   // chunks 只属 MDX，VR 不带

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
  // 只有老式的 model 字符串，没有 pipeline 键。
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
  const weightsDir = fs.mkdtempSync(path.join(os.tmpdir(), "uvr5-empty-")); // 什么都没装
  const ctx = ctxFor(inputDir, weightsDir, [{ model: "HP2", agg: 10 }]);

  await assert.rejects(() => denoise.run(ctx, () => {}), (err) => {
    assert.match(err.message, /not installed/);
    assert.match(err.message, /HP2_all_vocals\.pth/);
    assert.match(err.message, /download_uvr5\.py/);
    return true;
  });
  assert.equal(SPAWN_CALLS.length, 0); // 一次都没起进程

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
