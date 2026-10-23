// POST /api/assets/:id/refine 的行为测试。
// 用一份全部替身化的 ctx 搭出资产路由（不碰引擎、GPU 与文件系统），截下注册的
// handler，把每一条响应出口都走一遍，断言 HTTP 状态码与响应体（含错误码与成功负载）。
// 跑法：node --test tools/tests/refine_service.node.test.js
const path = require("path");
const Module = require("module");
const ROOT = path.resolve(__dirname, "..", "..");

const captured = {};
const expressShim = function () { const a = {}; for (const m of ["get","post","put","delete","patch","use","all"]) a[m] = () => a; return a; };
expressShim.Router = function () {
  const r = {};
  for (const m of ["get","put","delete","patch","use","all"]) r[m] = () => r;
  r.post = (p, ...h) => { captured[p] = h[h.length - 1]; return r; };
  return r;
};
expressShim.static = () => (q, s, n) => n && n();
expressShim.json = () => (q, s, n) => n && n();
expressShim.urlencoded = () => (q, s, n) => n && n();
const orig = Module._load;
Module._load = function (request) { if (request === "express") return expressShim; return orig.apply(this, arguments); };

const state = {};
// 默认：父角色已发布 S1/S2 权重，成功路径才走得通。
const ctx = {
  requireApiKey: (q, s, n) => n && n(),
  path, crypto: require("crypto"),
  fs: {
    // 跨平台：两边都解析成绝对路径，POSIX 写法的期望路径才能与生产里的输出对上，
    // 无论它是用 path.join 还是 path.resolve 拼出来的。path.normalize 不会换分隔符、
    // 也不会补盘符，只有 path.resolve 会。
    existsSync: (p) => (state.missingPaths ? !state.missingPaths.some((m) => path.resolve(m) === path.resolve(p)) : true),
    readFileSync: () => JSON.stringify(state.meta || { display_name: "Parent", language: "ja", base_version: "v2" }),
    readdirSync: (p, opt) => {
      if (opt && opt.withFileTypes) return [];
      // 已发布的模型放在 <asset>/models/<引擎id>/<权重位>/ 下，所以替身按最后一段
      // （权重位）判断，而不是按某个目录名。引擎段的名字里含有两个权重位名作为子串，
      // 用子串包含去匹配会连引擎段一起命中，所以每一段都要精确比较。
      const parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
      const slot = parts[parts.length - 1];
      const engine = parts[parts.length - 2];
      if (engine === "gpt-sovits" && slot === "gpt") return state.gptFiles !== undefined ? state.gptFiles : ["parent-e8.ckpt"];
      if (engine === "gpt-sovits" && slot === "sovits") return state.sovFiles !== undefined ? state.sovFiles : ["parent_v2_e8_s100.pth"];
      return [];
    },
    statSync: () => ({ isDirectory: () => !state.notDir }),
    mkdirSync() {}, cpSync() {}, copyFileSync() {}, rmSync() {},
  },
  ASSETS_DIR: "/assets",
  TRAIN_DATA_ROOT: "/root",
  safeId: (id) => !state.invalidId,
  assetId: { allocateVoiceId: () => "child1", reserve() {}, release() {} },
  clientError: (err) => err.message,
  collectTakenVoiceIds: () => [],
  normalizeVersion: (v) => v || "v2",
  versionFromName: (f) => "v2",
  pickLatestByEpoch: (files, re) => { const f = files[0]; const m = f && f.match(re); return { file: f, epoch: m ? Number(m[1]) : null }; },
  sanitizeCustomParams: (c) => ({ training: (c && c.training) || {} }),
  trainingPipeline: { createPipeline: () => { if (state.createThrows) throw new Error("kaboom"); return { id: "task_r", start: async () => {} }; } },
  withVoicesLock: (fn) => fn(),
};

require(path.join(ROOT, "lib", "routes", "assets.js"))(ctx);
const handler = captured["/api/assets/:id/refine"];
if (typeof handler !== "function") { console.error("FAIL: refine handler not captured"); process.exit(1); }

function run(id, body) {
  return new Promise((resolve) => {
    const res = { headersSent: false, _status: 200,
      status(c) { this._status = c; return this; },
      json(obj) { this.headersSent = true; resolve({ status: this._status, body: obj }); return this; } };
    handler({ params: { id }, body }, res, () => {});
  });
}
let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? "  -> " + d : ""}`); } };

(async () => {
  const reset = () => Object.keys(state).forEach(k => delete state[k]);

  reset(); state.invalidId = true; // safeId 的替身读这个标志
  let r = await run("!!bad", {});
  check("invalid id -> 400", r.status === 400 && r.body.error === "Invalid id", JSON.stringify(r));

  reset(); state.missingPaths = ["/assets/ghost"];
  r = await run("ghost", {});
  check("voice not found -> 404", r.status === 404 && /not found/.test(r.body.error), JSON.stringify(r));

  reset();
  r = await run("spk", { refinement_type: "none" });
  check("refine type empty -> 400", r.status === 400 && r.body.code === "REFINE_TYPE_EMPTY", JSON.stringify(r));

  reset();
  r = await run("spk", { use_own_data: true });
  check("input_dir required -> 400", r.status === 400 && r.body.code === "INPUT_DIR_REQUIRED", JSON.stringify(r));

  reset();
  r = await run("spk", { use_own_data: true, input_dir: "/elsewhere/in" });
  check("input_dir under root -> 400", r.status === 400 && /under TRAIN_DATA_ROOT/.test(r.body.error), JSON.stringify(r));

  reset(); state.missingPaths = ["/root/in"];
  r = await run("spk", { use_own_data: true, input_dir: "/root/in" });
  check("input_dir not exist -> 400", r.status === 400 && r.body.code === "INPUT_DIR_MISSING", JSON.stringify(r));

  reset(); state.gptFiles = []; // 父角色没有任何权重
  r = await run("spk", {});
  check("no checkpoints -> 400", r.status === 400 && r.body.code === "NO_CHECKPOINTS", JSON.stringify(r));

  reset();
  r = await run("spk", { base_s1_file: "missing-e1.ckpt", refinement_type: "s1+s2" });
  check("s1 ckpt not found -> 400", r.status === 400 && r.body.code === "CKPT_NOT_FOUND" && /S1 checkpoint/.test(r.body.error), JSON.stringify(r));

  reset();
  r = await run("spk", { base_s2_file: "missing_v2_e1_s1.pth" });
  check("s2 ckpt not found -> 400", r.status === 400 && r.body.code === "CKPT_NOT_FOUND" && /S2 checkpoint/.test(r.body.error), JSON.stringify(r));

  reset();
  r = await run("spk", { refinement_type: "s2" });
  check("success -> 200", r.status === 200 && r.body.ok === true && r.body.taskId === "task_r"
    && r.body.voiceId === "child1" && r.body.refinementType === "s2"
    && r.body.parentVoiceId === "spk" && r.body.generation === 1
    && r.body.baseS1Checkpoint === "parent-e8.ckpt" && r.body.dataMode === "reuse", JSON.stringify(r));

  reset(); state.createThrows = true;
  r = await run("spk", { refinement_type: "s2" });
  check("createPipeline throw -> 500 clientError", r.status === 500 && r.body.error === "kaboom", JSON.stringify(r));

  console.log(`\nrefine service test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
