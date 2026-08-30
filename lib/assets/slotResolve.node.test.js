// lib/assets/slotResolve.node.test.js
//
// ⭐⭐ 夹具一律建在 os.tmpdir() 下。⛔ 不许往真 assets/ 写。
//
// 这一份钉的是 2026-08-30 真机撞出来的那个坑：用户没建权重位那一层，
// 把一份模型直接摊在引擎目录下 ⇒ 平台认出了引擎、把那份模型的内部子目录
// 当成了权重位、把十几个文件整个丢掉，**而且一个字都没说**。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const L = require('./modelLayout');
const S = require('./slotResolve');

function tmpVoice() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-slotresolve-'));
}
function put(dir, rel, content = 'x') {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
function mkdir(dir, rel) {
  const full = path.join(dir, rel);
  fs.mkdirSync(full, { recursive: true });
  return full;
}
// 一个位、一份模型是一整个目录的引擎（形状取自真实名片，⛔ 名字不许出现在被测代码里）
const ONE_SLOT = [{ name: 'model', label: 'Model', param: null, applies_at: 'launch' }];
const TWO_SLOTS = [
  { name: 'gpt', label: 'GPT', param: 'gpt_path', applies_at: 'call' },
  { name: 'sovits', label: 'SoVITS', param: 'sovits_path', applies_at: 'call' },
];
const REQ = ['config.yaml', 'bpe.model', 'gpt.pth', 's2mel.pth'];

function resolve(voiceDir, engineId, slots, required) {
  const scanned = L.scanVoiceModels(voiceDir);
  return S.resolveEngineSlots({
    scannedSlots: scanned[engineId] || {},
    engineDir: L.engineModelsDir(voiceDir, engineId),
    slots,
    required,
  });
}

// ── 第 1 步（细）：按权重位分层 ─────────────────────────────────────

test('分层放对了：位目录里的每一项各是一个候选', () => {
  const v = tmpVoice();
  put(v, 'models/eng/model/a.pth');
  mkdir(v, 'models/eng/model/b-dir');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  assert.equal(r.layout, 'per_slot');
  assert.deepEqual(r.bySlot.model.map(c => c.name), ['a.pth', 'b-dir']);
  assert.deepEqual(r.notes, []);
});

test('分层放对了但位是空的：位在，值是空数组，⛔ 不是缺键', () => {
  const v = tmpVoice();
  mkdir(v, 'models/eng/gpt');
  put(v, 'models/eng/sovits/s.pth');
  const r = resolve(v, 'eng', TWO_SLOTS, []);
  assert.equal(r.layout, 'per_slot');
  assert.ok('gpt' in r.bySlot);
  assert.deepEqual(r.bySlot.gpt, []);
  assert.equal(r.bySlot.sovits.length, 1);
});

test('分层命中之后，其余目录名才被报成"不是权重位"', () => {
  const v = tmpVoice();
  put(v, 'models/eng/model/a.pth');
  put(v, 'models/eng/junkdir/x.bin');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  const n = r.notes.find(x => x.code === 'unknown_slot_dir');
  assert.ok(n, '应该报出不认识的目录');
  assert.deepEqual(n.dirs, ['junkdir']);
  assert.deepEqual(n.expected, ['model']);
  assert.ok(S.noteText(n, 'eng').includes('junkdir'));
});

test('分层命中时，直接躺在引擎目录下的文件要被报出来（⛔ 不许静默丢弃）', () => {
  const v = tmpVoice();
  put(v, 'models/eng/model/a.pth');
  put(v, 'models/eng/stray.pth');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  const n = r.notes.find(x => x.code === 'loose_files');
  assert.ok(n);
  assert.deepEqual(n.files, ['stray.pth']);
});

// ── 第 2 步（粗）：整个目录就是那一份模型 ───────────────────────────
//    ⭐ 这一条是**底模那一侧早就有**的规矩（lib/assets/baseModels.js 第 2 步），
//      角色资产这一侧此前没有 —— 同一份模型放底模目录能用、放角色目录不能用，
//      而且不报错。这几条测试就是钉这次对齐的。

test('没建位那一层 + 单权重位 ⇒ 整个引擎目录就是那一个候选', () => {
  const v = tmpVoice();
  put(v, 'models/eng/config.yaml');
  put(v, 'models/eng/gpt.pth');
  mkdir(v, 'models/eng/some-subdir');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  assert.equal(r.layout, 'whole_dir');
  assert.equal(r.bySlot.model.length, 1);
  assert.equal(r.bySlot.model[0].is_dir, true);
  assert.equal(r.bySlot.model[0].path, L.toPosix(L.engineModelsDir(v, 'eng')));
});

test('第 2 步命中时，⛔ 不许把那份模型自己的子目录报成"不是权重位"', () => {
  const v = tmpVoice();
  put(v, 'models/eng/config.yaml');
  mkdir(v, 'models/eng/hf_cache');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  assert.equal(r.notes.some(n => n.code === 'unknown_slot_dir'), false);
  assert.equal(r.notes.some(n => n.code === 'loose_files'), false);
  assert.ok(r.notes.some(n => n.code === 'whole_dir_as_candidate'));
});

test('位不止一个又没分层 ⇒ 宁可报空，⛔ 不许把同一个目录报成两个位的候选', () => {
  const v = tmpVoice();
  put(v, 'models/eng/a.pth');
  put(v, 'models/eng/b.pth');
  const r = resolve(v, 'eng', TWO_SLOTS, []);
  assert.equal(r.layout, 'none');
  assert.deepEqual(r.bySlot.gpt, []);
  assert.deepEqual(r.bySlot.sovits, []);
  const n = r.notes.find(x => x.code === 'ambiguous_no_slot_dir');
  assert.ok(n);
  assert.deepEqual(n.expected, ['gpt', 'sovits']);
  assert.ok(S.noteText(n, 'eng').includes('gpt / sovits'));
});

test('引擎目录空 / 不存在 ⇒ 没有候选也没有话说（⛔ 别为"本来就没有"制造噪音）', () => {
  const v = tmpVoice();
  mkdir(v, 'models/eng');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  assert.equal(r.layout, 'none');
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.bySlot.model, []);
});

test('名片一个权重位都没写 ⇒ 空结果，不是出错', () => {
  const v = tmpVoice();
  put(v, 'models/eng/whatever.pth');
  const r = resolve(v, 'eng', [], REQ);
  assert.deepEqual(r.bySlot, {});
  assert.deepEqual(r.notes, []);
  assert.equal(r.layout, 'none');
});

// ── 齐不齐：同一张 required 表，用在角色模型上 ──────────────────────

test('目录型候选按名片 required 逐项核对，缺什么说什么', () => {
  const v = tmpVoice();
  put(v, 'models/eng/model/mine/config.yaml');
  put(v, 'models/eng/model/mine/bpe.model');
  const r = resolve(v, 'eng', ONE_SLOT, REQ);
  const c = r.bySlot.model[0];
  assert.equal(c.complete, false);
  assert.deepEqual(c.missing, ['gpt.pth', 's2mel.pth']);
  assert.ok(c.missing_text.includes('gpt.pth'));
});

test('required 齐了 ⇒ complete = true', () => {
  const v = tmpVoice();
  for (const f of REQ) put(v, `models/eng/model/mine/${f}`);
  const r = resolve(v, 'eng', ONE_SLOT, REQ);
  assert.equal(r.bySlot.model[0].complete, true);
  assert.deepEqual(r.bySlot.model[0].missing, []);
  assert.equal('missing_text' in r.bySlot.model[0], false);
});

test('required 里可以是子目录，目录也算"有"', () => {
  const v = tmpVoice();
  mkdir(v, 'models/eng/model/mine/sub-model');
  const r = resolve(v, 'eng', ONE_SLOT, ['sub-model']);
  assert.equal(r.bySlot.model[0].complete, true);
});

test('⛔ 文件型候选不套 required —— 三态里的"说不出来"', () => {
  const v = tmpVoice();
  put(v, 'models/eng/gpt/a.ckpt');
  put(v, 'models/eng/sovits/b.pth');
  const r = resolve(v, 'eng', TWO_SLOTS, REQ);
  assert.equal(r.bySlot.gpt[0].complete, null);
  assert.deepEqual(r.bySlot.gpt[0].missing, []);
});

test('名片没写 required ⇒ complete 是 null，⛔ 不是 true 也不是 false', () => {
  const v = tmpVoice();
  mkdir(v, 'models/eng/model/mine');
  const r = resolve(v, 'eng', ONE_SLOT, []);
  assert.equal(r.bySlot.model[0].complete, null);
});

// ── Owner 2026-08-30 真机那一份，逐字复现 ──────────────────────────

test('真机复现：模型摊在引擎目录下 + 权重文件被改了名', () => {
  const v = tmpVoice();
  const req = ['config.yaml', 'bpe.model', 'gpt.pth', 's2mel.pth',
    'wav2vec2bert_stats.pt', 'feat1.pt', 'feat2.pt', 'qwen0.6bemo4-merge'];
  // 他放的：整套文件直接摊在引擎目录下，两个权重被改成了带角色名的名字
  for (const f of ['config.yaml', 'bpe.model', 'wav2vec2bert_stats.pt',
    'feat1.pt', 'feat2.pt', 'configuration.json', 'pinyin.vocab',
    'Akafuyu_zh.pth', 'Akafuyu_zh-e20.pth']) put(v, `models/eng/${f}`);
  mkdir(v, 'models/eng/qwen0.6bemo4-merge');
  mkdir(v, 'models/eng/hf_cache');

  const r = resolve(v, 'eng', ONE_SLOT, req);

  // ① 改之前：这里是空的，且没有任何一句话。现在它**选得出来**了。
  assert.equal(r.layout, 'whole_dir');
  assert.equal(r.bySlot.model.length, 1);
  // ② 而且当场说清它装不起来，以及为什么 —— ⛔ 不是等引擎抛栈。
  assert.equal(r.bySlot.model[0].complete, false);
  assert.deepEqual(r.bySlot.model[0].missing, ['gpt.pth', 's2mel.pth']);
  assert.ok(r.bySlot.model[0].missing_text.includes('文件名不能改'));
  // ③ 那两个子目录**不许**被报成"不是权重位"（它们是模型自己的结构）
  assert.equal(r.notes.some(n => n.code === 'unknown_slot_dir'), false);
});

// ── 守卫 ────────────────────────────────────────────────────────────

test('⛔ 守卫：对账这一层里不许出现任何引擎 id 或权重位名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'slotResolve.js'), 'utf8')
    // 先剥注释再找 —— 注释里举例子是允许的，代码里写死才是病。
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const banned of ['indextts2', 'gpt-sovits', "'gpt'", "'sovits'", "'model'"]) {
    assert.equal(src.includes(banned), false, `不许写死 ${banned}`);
  }
});
