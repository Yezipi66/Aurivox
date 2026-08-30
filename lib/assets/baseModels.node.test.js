// lib/assets/baseModels.node.test.js
// ---------------------------------------------------------------------------
//  底模发现：平台不许认识任何一台引擎
// ---------------------------------------------------------------------------
//
// ⛔⛔ 这一组测试守的是那个真栽过的错：因为「IndexTTS2 没有官方微调路径」
//    就推出「它在有哪些模型可用的清单里一个入口都没有」。
//    ⇒ 下面每一条都在同一件事上下注：**底模来源无关**，
//      目录里躺着什么就报什么，平台永远不问那是谁训的。
//
// ⚠ 夹具一律 os.tmpdir()。⛔ 绝不往真 engines/ 或真 assets/ 写一个字节 ——
//   并发跑测试时"弄脏的人全绿、别人随机红"，是这个仓库查过最久的一种坏法。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  baseModelsForEngine, baseModelsByEngine,
  registerBaseModelSource, _clearBaseModelSources,
} = require('./baseModels');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-basemodels-'));
}
function touch(p, bytes = 8) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
}
/** 一台假引擎的 profile：只带 baseModels 真正读的那几样。 */
function fakeProfile(id, weightSlots, ckAbs) {
  return {
    id,
    weight_slots: weightSlots,
    runtime: { checkpoints: ckAbs },   // 绝对路径 ⇒ path.resolve 原样返回
    models: null,
  };
}

test.beforeEach(() => _clearBaseModelSources());

// ── 通用规则 1：底模目录下按权重位分了子目录 ──────────────────────────────

test('⭐ 底模目录下按权重位分层时，逐位列出里面的东西', () => {
  const root = tmp();
  touch(path.join(root, 'gpt', 'base_s1.ckpt'));
  touch(path.join(root, 'gpt', 'community_s1.ckpt'));
  touch(path.join(root, 'sovits', 'base_s2.pth'));
  const p = fakeProfile('faketts', [{ name: 'gpt', label: 'G' }, { name: 'sovits', label: 'S' }], root);

  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(Object.keys(out).sort(), ['gpt', 'sovits']);
  assert.deepStrictEqual(out.gpt.map(e => e.name), ['base_s1.ckpt', 'community_s1.ckpt']);
  assert.deepStrictEqual(out.sovits.map(e => e.name), ['base_s2.pth']);
});

test('⭐⭐ 用户往底模目录里手放一份社区微调的权重，立刻就是候选（来源无关）', () => {
  // 这条是整件事的核心。⛔ 平台没有任何一条路径去问「这是谁训的」，
  //   所以它**不可能**因为"不是我们训练管线产的"而把它排除掉。
  const root = tmp();
  touch(path.join(root, 'model', 'someone-elses-finetune.safetensors'));
  const p = fakeProfile('faketts', [{ name: 'model', label: 'M' }], root);
  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(out.model.map(e => e.name), ['someone-elses-finetune.safetensors']);
});

test('候选可以是一整个目录，不只是文件（一份模型 = 一个目录的引擎很常见）', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'model', 'v2-ckpt-dir'), { recursive: true });
  touch(path.join(root, 'model', 'v2-ckpt-dir', 'config.yaml'));
  const p = fakeProfile('faketts', [{ name: 'model', label: 'M' }], root);
  const out = baseModelsForEngine(p, {});
  assert.strictEqual(out.model.length, 1);
  assert.strictEqual(out.model[0].name, 'v2-ckpt-dir');
  assert.strictEqual(out.model[0].is_dir, true);
});

// ── 通用规则 2：没分层 ⇒ 整个底模目录就是那一份候选 ─────────────────────

test('⭐⭐⭐ 单权重位、底模是一整套文件：整个目录就是那一个候选', () => {
  // IndexTTS2 就长这样：config.yaml + bpe.model + gpt.pth + s2mel.pth …
  // 一整个目录才是一份模型，拆开来任何一个文件都不是。
  // ⛔ 这条如果不成立，IndexTTS2 的下拉里就是空的 —— 正是原来的病。
  const root = tmp();
  for (const f of ['config.yaml', 'bpe.model', 'gpt.pth', 's2mel.pth']) touch(path.join(root, f));
  const p = fakeProfile('faketts', [{ name: 'model', label: 'M' }], root);
  const out = baseModelsForEngine(p, {});
  assert.strictEqual(out.model.length, 1, '整套文件应该被当成一份模型，而不是 0 份或 4 份');
  assert.strictEqual(out.model[0].is_dir, true);
  assert.strictEqual(out.model[0].path, root.replace(/\\/g, '/'));
});

test('⛔ 多个权重位却没分层 ⇒ 宁可报空，不许把同一个目录报成两个位的候选', () => {
  const root = tmp();
  touch(path.join(root, 'whatever.pth'));
  const p = fakeProfile('faketts', [{ name: 'a', label: 'A' }, { name: 'b', label: 'B' }], root);
  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(out, { a: [], b: [] });
});

// ── 边界：位在但空 ≠ 没有这个位 ────────────────────────────────────────

test('⭐ 底模还没下：位还在，值是空数组（不是缺键）', () => {
  const p = fakeProfile('faketts', [{ name: 'model', label: 'M' }], path.join(tmp(), 'not-downloaded-yet'));
  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(out, { model: [] }, '"这个位一个候选都没有" 和 "没有这个位" 是两件事');
});

test('名片没写底模在哪：位还在，值是空数组', () => {
  const p = { id: 'faketts', weight_slots: [{ name: 'model', label: 'M' }], runtime: {}, models: null };
  assert.deepStrictEqual(baseModelsForEngine(p, {}), { model: [] });
});

test('⭐ 名片没声明要选模型（weight_slots 空）⇒ 返回 {}，这是合法的不是出错', () => {
  const root = tmp();
  touch(path.join(root, 'x.pth'));
  assert.deepStrictEqual(baseModelsForEngine(fakeProfile('faketts', [], root), {}), {});
});

test('profile 是 null 也不炸', () => {
  assert.deepStrictEqual(baseModelsForEngine(null, {}), {});
});

// ── 覆盖钩子 ──────────────────────────────────────────────────────────

test('登记过的引擎走自己的找法，通用规则让位', () => {
  const root = tmp();
  touch(path.join(root, 'ignored.pth'));
  registerBaseModelSource('weirdtts', () => ({
    gpt: [{ name: '上游放在犄角旮旯的那个', path: '/x/y/s1.ckpt' }],
    sovits: [],
  }));
  const p = fakeProfile('weirdtts', [{ name: 'gpt', label: 'G' }, { name: 'sovits', label: 'S' }], root);
  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(out.gpt.map(e => e.name), ['上游放在犄角旮旯的那个']);
  assert.deepStrictEqual(out.sovits, []);
});

test('⛔ 登记的找法只能报名片声明过的位，多报的一律丢掉', () => {
  registerBaseModelSource('weirdtts', () => ({
    gpt: [{ name: 'a' }],
    这个位名片里根本没有: [{ name: 'b' }],
  }));
  const p = fakeProfile('weirdtts', [{ name: 'gpt', label: 'G' }], tmp());
  assert.deepStrictEqual(Object.keys(baseModelsForEngine(p, {})), ['gpt']);
});

test('⭐ 登记的找法抛异常时 fail-open：位还在，不把整台引擎带走', () => {
  registerBaseModelSource('weirdtts', () => { throw new Error('上游目录结构又变了'); });
  const p = fakeProfile('weirdtts', [{ name: 'gpt', label: 'G' }], tmp());
  assert.deepStrictEqual(baseModelsForEngine(p, {}), { gpt: [] });
});

// ── 多引擎汇总 ────────────────────────────────────────────────────────

test('⭐⭐ 两台引擎的底模按引擎分组，形状与角色资产那侧完全一致', () => {
  const a = tmp(); touch(path.join(a, 'gpt', 's1.ckpt')); touch(path.join(a, 'sovits', 's2.pth'));
  const b = tmp(); touch(path.join(b, 'config.yaml'));
  const out = baseModelsByEngine([
    fakeProfile('enginea', [{ name: 'gpt', label: 'G' }, { name: 'sovits', label: 'S' }], a),
    fakeProfile('engineb', [{ name: 'model', label: 'M' }], b),
  ], {});
  assert.deepStrictEqual(Object.keys(out).sort(), ['enginea', 'engineb']);
  assert.strictEqual(out.enginea.gpt.length, 1);
  assert.strictEqual(out.engineb.model.length, 1, '没有官方微调路径的引擎照样有底模候选');
});

test('一台引擎的名片坏了，不影响别台（fail-open 到格子，不是到整张表）', () => {
  const b = tmp(); touch(path.join(b, 'config.yaml'));
  const out = baseModelsByEngine([
    null,
    { id: 'broken' },                                   // 没有 weight_slots
    fakeProfile('engineb', [{ name: 'model', label: 'M' }], b),
  ], {});
  assert.ok(out.engineb, '好的那台必须还在');
  assert.strictEqual(out.engineb.model.length, 1);
});

// ── 纪律 ──────────────────────────────────────────────────────────────

test('⛔⛔ 平台代码里不许出现任何具体引擎 id 或权重位名', () => {
  // 出现了，就说明「给某台引擎单写一套」又回来了 —— 这个项目消灭过一次
  // 523 行的 shim，不能让它从这里长回来。
  const src = fs.readFileSync(path.join(__dirname, 'baseModels.js'), 'utf-8');
  const code = src.split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  for (const banned of ['gpt-sovits', 'indextts', 'GSV_', 'sovits', 'gpt.pth']) {
    assert.ok(!code.includes(banned), `baseModels.js 的代码里出现了 ${banned}`);
  }
});
