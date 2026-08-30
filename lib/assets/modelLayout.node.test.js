// lib/assets/modelLayout.node.test.js
//
// ⭐⭐ 夹具一律建在 os.tmpdir() 下。⛔ 不许往真 assets/ 写 —— 那正是
//    2026-08-30 那次「65 个真机 fail」的单一根因（测试往真目录写假数据，
//    多文件并行时互相读到半成品）。见记忆 aurivox-test-engines-dir-pollution。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('./modelLayout');

function tmpVoice() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-modellayout-'));
  return d;
}
function put(dir, rel, content = 'x') {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// ── 名片那张表：三种写法都收 ─────────────────────────────────────────

test('权重位声明：数字写法 → 生成 N 个位', () => {
  assert.deepEqual(L.normalizeWeightSlots(2), [
    { name: 'model_1', label: 'Model 1', param: null, applies_at: 'launch' },
    { name: 'model_2', label: 'Model 2', param: null, applies_at: 'launch' },
  ]);
  assert.deepEqual(L.normalizeWeightSlots(1), [{ name: 'model_1', label: 'Model 1', param: null, applies_at: 'launch' }]);
});

test('权重位声明：字符串数组 → 标签同名', () => {
  assert.deepEqual(L.normalizeWeightSlots(['aa', 'bb']), [
    { name: 'aa', label: 'aa', param: null, applies_at: 'launch' },
    { name: 'bb', label: 'bb', param: null, applies_at: 'launch' },
  ]);
});

test('权重位声明：完整写法保留标签', () => {
  assert.deepEqual(L.normalizeWeightSlots([{ name: 'aa', label: '甲模型' }]), [
    { name: 'aa', label: '甲模型', param: null, applies_at: 'launch' },
  ]);
});

test('⭐ 名片没写 = 这台引擎不需要用户选模型，不是出错', () => {
  assert.deepEqual(L.normalizeWeightSlots(undefined), []);
  assert.deepEqual(L.normalizeWeightSlots(null), []);
  assert.deepEqual(L.normalizeWeightSlots(0), []);
  assert.deepEqual(L.normalizeWeightSlots('随便写的一句话'), []);
});

test('⛔ 权重位名不许带路径分隔符（它直接进路径）', () => {
  assert.deepEqual(L.normalizeWeightSlots(['../../etc', 'a/b', '.', '..', 'ok']), [
    { name: 'ok', label: 'ok', param: null, applies_at: 'launch' },
  ]);
});

test('⛔ 重名的位只留第一个 —— 两个同名位会指向同一个目录', () => {
  assert.deepEqual(L.normalizeWeightSlots(['aa', 'aa']), [{ name: 'aa', label: 'aa', param: null, applies_at: 'launch' }]);
});

// ── 位怎么发给引擎（param）────────────────────────────────────────────
// param = 「用户选中的那一份，用哪个参数名发给引擎」。
// ⭐ 不写它是合法的，意思是「这台引擎运行中换不了权重」—— 此时界面照样
//   把候选列出来（能不能换 ≠ 有没有），只是那个选择不会被发出去。
// ⛔ 这里绝不能兜底造一个键：引擎不读它，用户以为换了、声音却没变，
//   不报任何错 —— 这是最难查的一类 bug。

test('位可以声明自己走哪个参数名', () => {
  assert.deepEqual(L.normalizeWeightSlots([{ name: 'aa', label: '甲', param: 'aa_model' }]), [
    { name: 'aa', label: '甲', param: 'aa_model', applies_at: 'call' },
  ]);
});

// ── 这一份选择送到哪一步（applies_at）─────────────────────────────────
// 只有两种，而且穷尽：
//   'launch' = 开进程那一步吃进去的 ⇒ 换一份 = 带着它重开一次；
//   'call'   = 进程活着时一次调用就能换。
// ⭐ 不写就按 param 推 —— 老名片一个字都不用改。
// ⛔ 默认取 'launch'：填错的后果不对称，该 launch 当 call 会静默不生效。

test('⭐ 不写 applies_at ⇒ 按 param 推（写了=call，没写=launch）', () => {
  assert.equal(L.normalizeWeightSlots([{ name: 'aa', param: 'k' }])[0].applies_at, 'call');
  assert.equal(L.normalizeWeightSlots([{ name: 'aa' }])[0].applies_at, 'launch');
  assert.equal(L.normalizeWeightSlots(['aa'])[0].applies_at, 'launch');
  assert.equal(L.normalizeWeightSlots(1)[0].applies_at, 'launch');
});

test('写了 applies_at 就以它为准（原样带出，合法性由名片解析那一层判）', () => {
  assert.equal(L.normalizeWeightSlots([{ name: 'aa', applies_at: 'launch' }])[0].applies_at, 'launch');
  assert.equal(L.normalizeWeightSlots([{ name: 'aa', applies_at: ' call ' }])[0].applies_at, 'call');
  assert.equal(L.normalizeWeightSlots([{ name: 'aa', applies_at: '瞎写的' }])[0].applies_at, '瞎写的');
});

test('⛔ 不写 param ⇒ null（换不了），不许瞎猜一个键名出来', () => {
  const decls = [['aa'], [{ name: 'aa' }], [{ name: 'aa', param: '' }], [{ name: 'aa', param: '   ' }], 1];
  for (const decl of decls) {
    for (const slot of L.normalizeWeightSlots(decl)) {
      assert.strictEqual(slot.param, null, JSON.stringify(decl) + ' 不该长出 param');
    }
  }
});

// ── 磁盘：扫出来是什么 ───────────────────────────────────────────────

test('⭐⭐ 有哪几台引擎的模型 = 看目录名，不问名片', () => {
  const v = tmpVoice();
  put(v, path.join('models', 'engine-zzz', 'slot-a', 'w.bin'));
  put(v, path.join('models', 'engine-aaa', 'slot-b', 'w.bin'));
  assert.deepEqual(L.enginesWithModels(v), ['engine-aaa', 'engine-zzz']);
});

test('没有 models 目录 = 空数组，不抛', () => {
  const v = tmpVoice();
  assert.deepEqual(L.enginesWithModels(v), []);
  assert.deepEqual(L.scanVoiceModels(v), {});
  assert.deepEqual(L.listSlotEntries(v, '不存在的引擎', '不存在的位'), []);
});

test('⭐ 一个候选可以是目录（有的引擎一个模型就是一整个目录）', () => {
  const v = tmpVoice();
  put(v, path.join('models', 'e1', 's1', '一个文件.bin'), 'abc');
  fs.mkdirSync(path.join(v, 'models', 'e1', 's1', '一个目录'), { recursive: true });
  const items = L.listSlotEntries(v, 'e1', 's1');
  assert.equal(items.length, 2);
  const dirItem = items.find(i => i.name === '一个目录');
  const fileItem = items.find(i => i.name === '一个文件.bin');
  assert.equal(dirItem.is_dir, true);
  assert.equal(dirItem.size_mb, null);
  assert.equal(fileItem.is_dir, false);
  assert.equal(typeof fileItem.size_mb, 'number');
});

test('⚠ 不筛后缀 —— 后缀是一台引擎的说法，平台列出目录里有什么', () => {
  const v = tmpVoice();
  put(v, path.join('models', 'e1', 's1', 'a.ckpt'));
  put(v, path.join('models', 'e1', 's1', 'b.pth'));
  put(v, path.join('models', 'e1', 's1', 'c.safetensors'));
  put(v, path.join('models', 'e1', 's1', 'd.谁也没见过的后缀'));
  assert.equal(L.listSlotEntries(v, 'e1', 's1').length, 4);
});

test('噪音文件不进候选', () => {
  const v = tmpVoice();
  put(v, path.join('models', 'e1', 's1', '.DS_Store'));
  put(v, path.join('models', 'e1', 's1', 'Thumbs.db'));
  put(v, path.join('models', 'e1', 's1', 'real.bin'));
  assert.deepEqual(L.listSlotEntries(v, 'e1', 's1').map(i => i.name), ['real.bin']);
});

test('⚠ 空的权重位要保留 —— 「位子在但空着」不等于「没这个位子」', () => {
  const v = tmpVoice();
  fs.mkdirSync(path.join(v, 'models', 'e1', 's1'), { recursive: true });
  put(v, path.join('models', 'e1', 's2', 'w.bin'));
  const scanned = L.scanVoiceModels(v);
  assert.deepEqual(Object.keys(scanned.e1).sort(), ['s1', 's2']);
  assert.deepEqual(scanned.e1.s1, []);
  assert.equal(scanned.e1.s2.length, 1);
});

test('⭐ 平台没听说过的引擎，模型照样扫得出来', () => {
  const v = tmpVoice();
  put(v, path.join('models', '谁都没见过的引擎', '谁都没见过的位', 'w.bin'));
  const scanned = L.scanVoiceModels(v);
  assert.equal(scanned['谁都没见过的引擎']['谁都没见过的位'].length, 1);
});

test('路径一律 posix 斜杠（配方/前端两边都按这个存）', () => {
  const v = tmpVoice();
  put(v, path.join('models', 'e1', 's1', 'w.bin'));
  const p = L.listSlotEntries(v, 'e1', 's1')[0].path;
  assert.ok(!p.includes('\\'), `路径里不该有反斜杠：${p}`);
});

// ── 老结构：报出来，不静默 ───────────────────────────────────────────

test('⭐⭐ 还没搬的角色要能被认出来（不能跟「没有模型」长得一样）', () => {
  const v = tmpVoice();
  put(v, path.join('gpt_checkpoints', 'a-e8.ckpt'));
  put(v, path.join('sovits_models', 'a_e8_s96.pth'));
  assert.deepEqual(L.legacyDirsPresent(v), ['gpt_checkpoints', 'sovits_models']);
  // ⛔ 而且平台不再从这两个目录读出任何候选
  assert.deepEqual(L.scanVoiceModels(v), {});
});

test('空的老目录不算「还没搬」', () => {
  const v = tmpVoice();
  fs.mkdirSync(path.join(v, 'gpt_checkpoints'), { recursive: true });
  assert.deepEqual(L.legacyDirsPresent(v), []);
});

// ── 纪律 ─────────────────────────────────────────────────────────────

test('⛔ 这个文件里不许出现任何具体引擎 id 或权重位名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'modelLayout.js'), 'utf-8');
  // 注释里举例说明是允许的；这里查的是代码行。
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const banned of ['gpt-sovits', 'indextts2', "'gpt'", "'sovits'", '"gpt"', '"sovits"']) {
    assert.ok(!code.includes(banned), `代码里不该出现 ${banned}`);
  }
  // LEGACY_MODEL_DIRS 是唯一例外，且只用于「报出来还没搬」。
  assert.ok(code.includes('gpt_checkpoints'), 'LEGACY_MODEL_DIRS 应保留到搬家工具退役');
});
