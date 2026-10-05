'use strict';

/**
 * lib/inference/alias_fold.py 的守卫 —— 请求别名折叠。
 *
 * ⭐ 为什么这条测试要真的去 spawn 一个 Python
 * -------------------------------------------
 * `infer_server.py` 一 import 就把整个 GPT-SoVITS 推理栈拉起来（TTS、大
 * 模型、配置自检……），**测试里根本起不来**。所以折叠判断被抽到
 * alias_fold.py 里（纯函数、零依赖），这里真去调它。
 * 形状照抄 configRepair.node.test.js（同一个目录的既有做法）。
 *
 * ⭐ 这条守卫在守什么
 * -------------------
 * 一件**已经发生过**的静默失败：平台的 manifest 里有 `if_sr` 那一格
 * （label "Super Sampling (v3)"），assembleEnginePayload 照 payload_keys 原样
 * 把它发给引擎；而下游 TTS.py:1229 读的是 `super_sampling`，中间那个宿主的
 * `TTS_Request` 只有 super_sampling —— pydantic v2 静默忽略多余字段。
 * ⇒ 用户打开「Super Sampling」、点生成，声音一点不变，**没有一处报错**。
 *
 * 这类失败的特点是「测试全绿 + 声音不对」，所以守卫必须能回答两个问题：
 *   1. 平台那个键折过去了吗？        （行为）
 *   2. 别名表和宿主/下游**还对得上**吗？（接线 —— 见下面「别名表不许漂移」）
 *
 * 找不到 Python 解释器时整组 skip 并说明原因, 不静默通过。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { firstWorkingPython, projectPythonCandidates } = require('../util/pythonResolve')

const MODULE_PATH = path.join(__dirname, 'alias_fold.py');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * ⭐ 先试这台引擎自己的 venv（pydantic 在那儿），再退到根 venv / 内嵌 runtime / PATH。
 *
 * ⚠️ 2026-10-04（A15）：判据从「文件存在」换成「**按绝对路径起一次**看退出码」。
 *   从前是 `fs.existsSync(c)` —— 而本机上那台引擎的 venv 文件**在**，
 *   只是它的 base 解释器指向另一台机器。那个形状会一路走到断言里才炸，
 *   报错是 `uv trampoline failed to spawn`，**看不出是「环境选错了」**。
 *
 * ⚠️⚠️ 仍然有一个**诚实的缺口**：这些测试要 import `infer_server.py` 的
 *   `TTS_Request`，那需要 **pydantic**。而本仓库自带的内嵌 runtime 是**裸解释器**
 *   （没有 pydantic）⇒ 它会被选中，然后在这里 import 失败。
 *   ⇒ 补齐要等**那台引擎的 venv 按名片的 env_command 重建好**（E1）。
 *   ⛔ 本文件**不许**去用仓库外手建的环境来凑 —— 那会让测试依赖一个
 *      没有 freeze、没有进版本库的环境。
 *
 * 详见 `lib/util/pythonResolve.js` 的文件头。
 */
function findPython() {
  return firstWorkingPython(projectPythonCandidates(PROJECT_ROOT, [
    // ⭐ 先试这台引擎的 venv：接线测试要抠 infer_server.py 里的 TTS_Request，
    //   那需要 pydantic —— 根 venv 与内嵌 runtime 都不一定装了。
    path.join(PROJECT_ROOT, 'engines', 'gpt-sovits', '.venv', 'Scripts', 'python.exe'),
    path.join(PROJECT_ROOT, 'engines', 'gpt-sovits', '.venv', 'bin', 'python'),
  ]));
}

const PYTHON = findPython();
const SKIP = PYTHON ? false : '找不到可用的 Python 解释器（引擎 venv / 根 venv / 内嵌 runtime / PATH 都试过了），无法驱动 alias_fold.py';

function fold(req) {
  const res = spawnSync(PYTHON, [MODULE_PATH, '--req', JSON.stringify(req)], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, `探针非零退出:\n${res.stderr || ''}`);
  return JSON.parse(res.stdout).folded;
}

// ===========================================================================
//  1) 行为 —— 平台那个键折过去了
// ===========================================================================

test('⭐ 平台的 if_sr 折成下游认的 super_sampling（这一格以前是死的）', { skip: SKIP }, () => {
  const out = fold({ text: 'hi', if_sr: true });
  assert.strictEqual(out.super_sampling, true, 'if_sr 没有折成 super_sampling —— 这一格仍然是死的');
});

test('⭐ 折完把别名摘掉，不给 TTS.py 留一个没人认的键', { skip: SKIP }, () => {
  const out = fold({ text: 'hi', if_sr: true });
  assert.ok(!('if_sr' in out), 'if_sr 还留在折叠后的请求里 —— TTS.py 不认它，留着只会更难查谁读的');
});

test('⭐ 用户明确关掉的那一格不会被别处的默认值打开', { skip: SKIP }, () => {
  // ⛔ 这一条防的是把 `if req.get(k) is not None` 写成 `if req.get(k)`。
  //    写成 truthy 的话：if_sr=False 被当成「没给」→ 不折叠 →
  //    下游拿自己的默认值 False（碰巧对）；但 super_sampling=True 同时在场时
  //    用户明明关掉了，值却成了 True。**用户设的 False 必须赢。**
  const out = fold({ if_sr: false, super_sampling: true });
  assert.strictEqual(out.super_sampling, false,
    '用户明确给了 if_sr=False，却被 super_sampling=True 覆盖了 —— 用户设的值必须赢');
});

test('两个都在时：平台的规范键赢（它是用户在界面上动过的那个）', { skip: SKIP }, () => {
  const out = fold({ if_sr: true, super_sampling: false });
  assert.strictEqual(out.super_sampling, true, '规范键 if_sr 应该赢');
});

test('平台没动过那一格 ⇒ 不折叠，交给引擎自己的默认值', { skip: SKIP }, () => {
  // 界面上没碰过的格子 = 「界面建议」，不是「用户选的」。平台不该替用户决定。
  const out = fold({ text: 'hi', top_k: 15 });
  assert.ok(!('super_sampling' in out), '没给 if_sr 却塞了 super_sampling —— 平台在替用户决定');
  assert.strictEqual(out.top_k, 15, '不相干的键不该被碰');
});

test('已经用下游名字给了、原样留着（向后兼容）', { skip: SKIP }, () => {
  const out = fold({ text: 'hi', super_sampling: true });
  assert.strictEqual(out.super_sampling, true);
});

test('非 dict 直接报错，不静默放过', { skip: SKIP }, () => {
  const res = spawnSync(PYTHON, [MODULE_PATH, '--req', 'not-json'], { encoding: 'utf8' });
  assert.notStrictEqual(res.status, 0, '收一个不是 dict 的东西还安静返回，错误就被推到更深处了');
});

// ===========================================================================
//  2) 接线 —— 别名表和宿主/下游还对得上吗
// ===========================================================================

/** 从 infer_server.py 里抠出 TTS_Request 的字段名（那文件起不来，只读源码）。 */
function hostRequestFields() {
  const src = fs.readFileSync(path.join(__dirname, 'infer_server.py'), 'utf8');
  const seg = src.slice(src.indexOf('class TTS_Request(BaseModel):'), src.indexOf('class PronPreviewRequest'));
  return new Set([...seg.matchAll(/^\s{4}(\w+)\s*:/gm)].map(m => m[1]));
}

/** alias_fold 的 ALIASES（读源码，因为它不是 JSON 出口的一部分）。 */
function aliases() {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  const m = src.match(/ALIASES\s*=\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'alias_fold.py 里读不到 ALIASES —— 表被改名/挪走了？');
  const out = {};
  for (const mm of m[1].matchAll(/"([a-z_]+)":\s*"([a-z_]+)"/g)) out[mm[1]] = mm[2];
  return out;
}

test('⭐⭐ 接线判据：每一条别名，宿主和下游都认右边那个键', () => {
  // ⭐ 这条是这份测试存在的**主要理由**。
  //   修好折叠只解决「平台那个键折过去了」；如果哪天有人改了 infer_server.py
  //   或 TTS.py 的键名，折叠就折成了一个没人认的键 —— 而那条路上**没有任何
  //   报错**（那正是当初把 if_sr 静默丢掉的那个机制本身）。
  const host = hostRequestFields();
  const down = fs.readFileSync(
    path.join(PROJECT_ROOT, 'engines', 'gpt-sovits', 'infer', 'TTS.py'), 'utf8');

  const broken = [];
  for (const [canonical, downstream] of Object.entries(aliases())) {
    if (!host.has(downstream)) broken.push(`${downstream} —— infer_server.py 的 TTS_Request 里没有`);
    if (!down.includes(`"${downstream}"`)) broken.push(`${downstream} —— engines/gpt-sovits/infer/TTS.py 里没人读`);
    if (!down.includes(`"${canonical}"`)) {
      // ⛔ 不是错，是**记录**：如果哪天下游开始直接认 if_sr 了，这条别名
      //   就该退休（而不是让它悄悄变成一次多余但无害的折叠）。
      continue;
    }
  }
  assert.deepEqual(broken, [],
    '这些别名折过去之后没有任何人认 —— 折叠本身会把一个参数静默变成空气。' +
    '要么下游改了键名（那要更新 ALIASES），要么这条别名该退休。');
});

test('⭐ 名片里那个格子用的正是别名的左边（平台发的是 if_sr，不是 super_sampling）', () => {
  // ⭐ 这条锁的是「平台侧到底发哪个键」。如果哪天有人「顺手把名片也改成
  //   super_sampling」，那存量 v3 配方就会读错（C11 豁免表里登记着这件事）。
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'engines', 'gpt-sovits', 'manifest.json'), 'utf8'));
  const schemaNames = Object.keys(((manifest.params || {}).schema) || {});
  const pk = manifest.payload_keys || [];

  for (const canonical of Object.keys(aliases())) {
    assert.ok(schemaNames.includes(canonical) || pk.includes(canonical),
      `名片里没有 ${canonical} —— 平台不会发它，那这条别名是空转的`);
  }
  // ⛔ 反向：super_sampling **不许**进 param_schema（那会变成第二份事实，
  //    而且存量 v3 配方读的是 if_sr）。
  assert.ok(!schemaNames.includes('super_sampling'),
    'param_schema 里出现了 super_sampling —— v3 配方存的是 if_sr，改名会让存量配方读错');
});

test('⭐ 宿主确实调了 fold_aliases（接线不是「我写了但没接」）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'infer_server.py'), 'utf8');
  assert.ok(/^from alias_fold import fold_aliases/m.test(src),
    'infer_server.py 没有 import fold_aliases');
  // 而且要**真的调**，不是在 import 旁边写段注释说「将来要调」。
  const calls = (src.match(/^\s*fold_aliases\(/gm) || []).length;
  assert.ok(calls >= 1, 'infer_server.py import 了 fold_aliases 却没调用');
});

test('宿主的 TTS_Request 认得 if_sr（否则 pydantic 会把它静默丢掉）', () => {
  const host = hostRequestFields();
  assert.ok(host.has('if_sr'),
    "infer_server.py 的 TTS_Request 里没有 if_sr —— pydantic 会静默忽略它，" +
    '这就是本次要修的那个 bug 本身');
  assert.ok(host.has('super_sampling'), 'TTS_Request 里应该有折叠后的那个键');
});
