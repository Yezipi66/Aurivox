// UVR5 模型登记表的守卫测试：流水线阶段的归一化、权重目录的约定与安装状态。
// 用 Node 内置的测试运行器，不依赖 jest。
//
// 被测契约（uvr5_models.js）：
//   * normalizePipeline 收下旧写法，丢掉不认识的模型，agg 夹到范围内，
//     非 VR 架构不带 agg，阶段数不超过 MAX_PIPELINE_STAGES。
//   * installed / missing / catalogue 反映盘上真实的权重文件。

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const uvr5 = require("./uvr5_models");

// 项目根一路上溯找 server.js，不按目录层数推导：判定物与 lib/paths.js 的
// detectAppDir、engines/gpt-sovits 的 chinese2.py 的 _find_project_root 一致。
// 这棵树的位置一变，按层数推导就会指向不存在的文件；找不到时显式抛错。
function findProjectRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, "server.js"))) return d;
    const parent = path.dirname(d);
    if (parent === d) {
      throw new Error(
        "project root not found above " + start + " (looked for server.js); " +
        "refusing to fall back to counting directory levels (C7)");
    }
    d = parent;
  }
}
const PROJECT_ROOT = findProjectRoot(__dirname);

// 下载与读取说的是同一件事：权重放在哪里。两边各写各的就会说岔，
// 面板上给一个下载按钮，写进去的目录读取那一侧根本不看，模型始终显示未安装。
const downloaderSource = fs.readFileSync(
  path.join(__dirname, "download_uvr5.py"), "utf8");

test("下载器的架构表必须与注册表逐条一致", () => {
  const block = downloaderSource.match(/^ARCH = \{([\s\S]*?)^\}/m);
  assert.ok(block, "download_uvr5.py 里找不到 ARCH 表");
  const declared = {};
  for (const line of block[1].split(/\r?\n/)) {
    const m = line.match(/^\s*"([^"]+)":\s*"([^"]+)"/);
    if (m) declared[m[1]] = m[2];
  }

  const ids = uvr5.MODELS.map((m) => m.id).sort();
  assert.deepEqual(Object.keys(declared).sort(), ids,
    "下载器与注册表的模型清单对不上");
  for (const m of uvr5.MODELS) {
    assert.equal(declared[m.id], m.arch,
      `${m.id} 的架构目录：注册表说 ${m.arch}，下载器说 ${declared[m.id]}`);
  }
});

test("下载器不得自己拼一个旁边的权重目录", () => {
  assert.ok(!/_HERE\s*,\s*"uvr5_weights"/.test(downloaderSource),
    "下载器又把权重写到自己旁边的 uvr5_weights/ 了；那里没有人读");
  assert.ok(/models", "separation", "uvr5"/.test(downloaderSource),
    "下载器的默认目标必须是 models/separation/uvr5");
  assert.ok(/os\.path\.join\(dest, ARCH\[model\]\)/.test(downloaderSource),
    "下载的文件必须落进架构子目录，不能摊平放在权重根下");
});

test("下载路由必须把权重目录显式传给下载器", () => {
  const routeSource = fs.readFileSync(
    path.join(PROJECT_ROOT, "lib", "routes", "uvr5.js"), "utf8");
  assert.ok(/"--dest",\s*weightsDir/.test(routeSource),
    "路由起下载时没传 --dest；下载器只能去猜，猜错就是白下几个 GB");
});

// 归一后的阶段带各架构自己的进阶参数默认值。多数用例只关心 model 与 agg，
// 所以这里把阶段投影到这两个键上再比。
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
  // 不需要 yaml（内置默认配置），所以只要求 ckpt 一个文件。
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
  // 非 VR 架构的参数不能漏到 VR 阶段上。
  assert.equal(s.chunks, undefined);
  assert.equal(s.overlap, undefined);
});

test("expert params: VR knobs are coerced/clamped and enums validated", () => {
  const [s] = uvr5.normalizePipeline([
    { model: "HP2", tta: "true", postprocess: 1, highEnd: "bogus", precision: "fp16" },
  ]);
  assert.equal(s.tta, true);
  assert.equal(s.postprocess, true);
  assert.equal(s.highEnd, "mirroring"); // 非法枚举值退回默认值
  assert.equal(s.precision, "fp16");
});

test("expert params: MDX exposes chunks+precision only (no agg/tta)", () => {
  const [s] = uvr5.normalizePipeline([{ model: "MDX-Net", chunks: 999, tta: true }]);
  assert.equal(s.agg, undefined);
  assert.equal(s.tta, undefined);
  assert.equal(s.chunks, 40); // 夹到上限
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
    // 权重放在架构目录下，报为缺失的路径正是补齐它要创建的那些路径。
    assert.equal(uvr5.isInstalled(dir, "HP2"), false);
    assert.deepEqual(uvr5.missingFiles(dir, "HP2"),
      [path.join("vr", "HP2_all_vocals.pth")]);

    // 按报出来的路径逐条补齐，补齐本身就该让它变成已安装。
    for (const rel of uvr5.missingFiles(dir, "HP2")) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), "x");
    }
    assert.equal(uvr5.isInstalled(dir, "HP2"), true);
    assert.deepEqual(uvr5.missingFiles(dir, "HP2"), []);

    // 放在架构目录之外的权重不算已安装。
    fs.writeFileSync(path.join(dir, "HP3_all_vocals.pth"), "x");
    assert.equal(uvr5.isInstalled(dir, "HP3"), false);

    // MDX-Net 是目录型模型（mdx/onnx_dereverb_By_FoxJoy/vocals.onnx）。
    assert.equal(uvr5.isInstalled(dir, "MDX-Net"), false);
    fs.mkdirSync(path.join(dir, "mdx", "onnx_dereverb_By_FoxJoy"), { recursive: true });
    fs.writeFileSync(path.join(dir, "mdx", "onnx_dereverb_By_FoxJoy", "vocals.onnx"), "x");
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
    path.join(dir, "mdx", "onnx_dereverb_By_FoxJoy"));
  assert.equal(uvr5.resolveWeightArg(dir, "HP2"),
    path.join(dir, "vr", "HP2_all_vocals.pth"));
});

// python 侧的载入器拿整条路径做子串匹配来认架构，而载入 state dict 时很宽容：
// 认错架构不会报错，只会让声音不对。所以目录名是承重的，每个模型都必须落在这三个目录之一。
test("every model resolves under vr/ roformer/ mdx/ and nowhere else", () => {
  const allowed = new Set(["vr", "roformer", "mdx"]);
  const trap = /bs_roformer|mel_band|melband|dereverb/i;
  for (const m of uvr5.MODELS) {
    assert.ok(allowed.has(m.arch), `${m.id}: unknown arch "${m.arch}"`);
    assert.ok(!trap.test(m.arch),
      `${m.id}: arch directory "${m.arch}" contains a string the python ` +
      `loaders match on, which would silently select the wrong architecture`);
    for (const rel of uvr5.modelFiles(m.id)) {
      assert.equal(rel.split(path.sep)[0], m.arch,
        `${m.id}: ${rel} is not under its own architecture directory`);
    }
  }
});
