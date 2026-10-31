// lib/assets/baseModels.node.test.js
//  底模清单：平台不许认识任何一台引擎
//
//  这一组测试守的是一条推理错误：不能因为「IndexTTS2 没有官方微调路径」
//  就推出「它在有哪些模型可用的清单里一个入口都没有」。
//  ⇒ 没声明 base_models 的那台：底模目录里躺着什么就报什么，平台不问那是谁训的；
//    声明了的那台：只报声明过的候选，一条声明对应一个位上的一个条目。
//
//  夹具一律 os.tmpdir()。 绝不往真 engines/ 或真 assets/ 写一个字节 ：
//  并发跑测试时"弄脏的人全绿、别人随机红"，是这个仓库查过最久的一种坏法。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 声明式底模候选要经过 registry 读引擎目录，所以先造一个临时 engines/ 再加载 baseModels。
const tmpEngines = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-base-engines-'));
process.env.AURIVOX_EXTRA_ENGINES_DIR = tmpEngines;

function putEngine(id, scan) {
  fs.mkdirSync(path.join(tmpEngines, id), { recursive: true });
  fs.writeFileSync(path.join(tmpEngines, id, 'manifest.json'), JSON.stringify({ id }));
  if (scan) fs.writeFileSync(path.join(tmpEngines, id, 'scan.json'), JSON.stringify(scan));
}

// 假引擎的位名与显示名故意和仓库里任何一台真引擎无关：用 gpt / sovits 当夹具，
// 平台里残留一条按位名分支的写法也照样绿。
putEngine('declared-base', {
  base_models: [
    { slot: 'encoder', name: 'Starter enc', steps: null, default: true, candidates: ['e2/enc.bin', 'e1/enc.bin'] },
    { slot: 'decoder', name: 'Starter dec A', version: 'revA', candidates: ['d2/decA.bin', 'd1/decA.bin'] },
    { slot: 'decoder', name: 'Starter dec B', version: 'revB', default: true, candidates: ['d3/decB.bin'] },
  ],
});
putEngine('bare-base');
// 写了命名约定、没写 base_models 的那台：有 scan.json 不等于声明了底模。
putEngine('named-base', { language_from_name: ['_(?<lang>[a-z]{2})\\.bin$'] });
putEngine('no-scan-base');
putEngine('broken-base', { base_models: [{ slot: 'decoder', name: 'x', candidate: ['a.bin'] }] });

const { baseModelsForEngine, baseModelsByEngine } = require('./baseModels');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-basemodels-'));
}
function touch(p, bytes = 8) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
}
const posix = (p) => p.replace(/\\/g, '/');
/** 一台假引擎的 profile：只带 baseModels 真正读的那几样。 */
function fakeProfile(id, weightSlots, ckAbs) {
  return {
    id,
    weight_slots: weightSlots,
    runtime: { checkpoints: ckAbs },   // 绝对路径 ⇒ path.resolve 原样返回
    models: null,
  };
}
const ENC = [{ name: 'encoder', label: 'E' }];
const ENC_DEC = [{ name: 'encoder', label: 'E' }, { name: 'decoder', label: 'D' }];

// ── 通用规则 1：底模目录下按权重位分了子目录 ──────────────────────────────

test('⭐ 底模目录下按权重位分层时，逐位列出里面的东西', () => {
  const root = tmp();
  touch(path.join(root, 'encoder', 'base_enc.bin'));
  touch(path.join(root, 'encoder', 'community_enc.bin'));
  touch(path.join(root, 'decoder', 'base_dec.bin'));
  const p = fakeProfile('faketts', ENC_DEC, root);

  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(Object.keys(out).sort(), ['decoder', 'encoder']);
  assert.deepStrictEqual(out.encoder.map(e => e.name), ['base_enc.bin', 'community_enc.bin']);
  assert.deepStrictEqual(out.decoder.map(e => e.name), ['base_dec.bin']);
});

test('⭐⭐ 用户往底模目录里手放一份社区微调的权重，立刻就是候选（没声明的那台来源无关）', () => {
  // 这条是整件事的核心。 平台没有任何一条路径去问「这是谁训的」，
  //  所以它不可能因为"不是我们训练管线产的"而把它排除掉。
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
  // 这条若不成立，IndexTTS2 的下拉里就是空的。
  const root = tmp();
  for (const f of ['config.yaml', 'bpe.model', 'gpt.pth', 's2mel.pth']) touch(path.join(root, f));
  const p = fakeProfile('faketts', [{ name: 'model', label: 'M' }], root);
  const out = baseModelsForEngine(p, {});
  assert.strictEqual(out.model.length, 1, '整套文件应该被当成一份模型，而不是 0 份或 4 份');
  assert.strictEqual(out.model[0].is_dir, true);
  assert.strictEqual(out.model[0].path, posix(root));
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

// ── 声明式：引擎在 scan.json 里给出候选清单 ───────────────────────────────

test('⭐ 声明了 base_models ⇒ 按声明顺序取第一个存在的候选，条目形状照旧', () => {
  const root = tmp();
  const enc = path.join(root, 'e2', 'enc.bin');
  const decA = path.join(root, 'd1', 'decA.bin');
  const decB = path.join(root, 'd3', 'decB.bin');
  touch(enc);
  touch(decA);
  touch(decB);
  const p = fakeProfile('declared-base', ENC_DEC, root);

  const out = baseModelsForEngine(p, {});
  assert.deepStrictEqual(out.encoder, [
    { name: 'Starter enc', path: posix(enc), steps: null, builtin: true, default: true },
  ]);
  // dec A 的第一个候选不在盘上 ⇒ 落到第二个。
  assert.deepStrictEqual(out.decoder.map(e => e.name), ['Starter dec A', 'Starter dec B']);
  assert.equal(out.decoder[0].path, posix(decA));
  assert.equal(out.decoder[0].version, 'revA');
  assert.equal(out.decoder[0].default, false);
  assert.equal(out.decoder[1].path, posix(decB));
  assert.equal(out.decoder[1].version, 'revB');
  assert.equal(out.decoder[1].default, true);
});

test('一条声明的多个候选都在盘上 ⇒ 取声明里的第一条', () => {
  // 顺序本身要靠这条守：只测「首选不在盘上，于是落到第二选」的场合，
  // 把候选顺序整个倒过来念照样全绿。旧下拉靠 _BASE_SOVITS_DEFS 的书写顺序，新契约靠 scan.json 的，同一件事。
  const root = tmp();
  touch(path.join(root, 'e1', 'enc.bin'));
  touch(path.join(root, 'e2', 'enc.bin'));
  touch(path.join(root, 'd1', 'decA.bin'));
  touch(path.join(root, 'd2', 'decA.bin'));
  const out = baseModelsForEngine(fakeProfile('declared-base', ENC_DEC, root), {});
  assert.equal(out.encoder.length, 1, '一条声明只出一条候选，不是每个在盘上的候选各出一条');
  assert.equal(out.encoder[0].path, posix(path.join(root, 'e2', 'enc.bin')));
  assert.deepStrictEqual(out.decoder.map(e => e.name), ['Starter dec A']);
  assert.equal(out.decoder[0].path, posix(path.join(root, 'd2', 'decA.bin')));
});

test('声明过的候选之外的文件不算底模：按声明取，不把目录里躺着的东西一起报出来', () => {
  const root = tmp();
  touch(path.join(root, 'e2', 'enc.bin'));
  touch(path.join(root, 'e2', 'someone-elses-enc.bin'));
  touch(path.join(root, 'd3', 'decB.bin'));
  const out = baseModelsForEngine(fakeProfile('declared-base', ENC_DEC, root), {});
  assert.deepStrictEqual(out.encoder.map(e => e.name), ['Starter enc'],
    '声明了 base_models 就是「这台引擎认这几份官方权重」，手动放进去的不算');
  assert.deepStrictEqual(out.decoder.map(e => e.name), ['Starter dec B']);
});

test('声明了候选但盘上一份都没有 ⇒ 位还在，值是空数组', () => {
  const p = fakeProfile('declared-base', ENC_DEC, tmp());
  assert.deepStrictEqual(baseModelsForEngine(p, {}), { encoder: [], decoder: [] });
});

test('声明了 base_models 但名片没写底模在哪 ⇒ 位还在，值是空数组', () => {
  const p = fakeProfile('declared-base', ENC_DEC, tmp());
  p.runtime = {};
  assert.deepStrictEqual(baseModelsForEngine(p, {}), { encoder: [], decoder: [] });
});

test('⛔ 声明里的位名片没有 ⇒ 报错点名那个位和两种改法，不静默丢掉', () => {
  putEngine('declared-stray', {
    base_models: [
      { slot: 'encoder', name: 'x', candidates: ['x.bin'] },
      { slot: 'not-a-slot', name: 'y', candidates: ['y.bin'] },
    ],
  });
  const root = tmp();
  touch(path.join(root, 'x.bin'));
  const p = fakeProfile('declared-stray', ENC, root);
  assert.throws(() => baseModelsForEngine(p, {}), (err) => {
    assert.equal(err.code, 'ENGINE_SCAN_INVALID');
    assert.equal(err.engine_id, 'declared-stray');
    assert.match(err.message, /not-a-slot/);
    assert.match(err.message, /名片的 weights 里没有这个位/);
    assert.match(err.message, /encoder/, '报错要说出名片里到底有哪些位');
    return true;
  });
});

test('没写 base_models 的引擎走通用目录规则（不因有 scan.json 就变空）', () => {
  // 有 scan.json 但里面没这一段 ⇒ 仍按目录报。只拿「根本没有 scan.json」的那台测，
  // 「有 scan.json 就以为声明过了」这种写法照样能过。
  for (const id of ['named-base', 'bare-base']) {
    const root = tmp();
    touch(path.join(root, 'model', 'base.safetensors'));
    const p = fakeProfile(id, [{ name: 'model', label: 'M' }], root);
    assert.deepStrictEqual(baseModelsForEngine(p, {}).model.map(e => e.name), ['base.safetensors'],
      `${id} 的通用目录规则没报出盘上的那份底模`);
  }
});

// ── GSV：声明逐条复刻旧下拉，且每条的非首选候选都能落到 ──────────────────

test('⭐⭐ GSV 的 base_models 声明复刻旧下拉：三条版本、v2Pro 默认、候选按声明顺序', () => {
  const root = tmp();
  const profile = require('../engines/profile').resolveEngineProfile('gpt-sovits');
  // 夹具按名片声明的底模目录摆放，避免在测试里重复定义项目布局。
  const ck = path.join(root, profile.runtime.checkpoints);
  // 盘上只有 v2 的 s1/s2G、v2Pro 的 s2G 与 v2ProPlus 的 s2G：每个版本各出一条候选。
  touch(path.join(ck, 'v2', 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'));
  touch(path.join(ck, 'v2', 's2G2333k.pth'));
  touch(path.join(ck, 'v2Pro', 's2Gv2Pro.pth'));
  touch(path.join(ck, 'v2ProPlus', 's2Gv2ProPlus.pth'));

  const out = baseModelsForEngine(profile, { appDir: root, env: {} });
  assert.deepStrictEqual(out.gpt, [{
    name: 'Base model_s1',
    path: posix(path.join(ck, 'v2', 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt')),
    steps: null,
    builtin: true,
    default: true,
  }]);
  assert.deepStrictEqual(out.sovits.map(e => e.name),
    ['Base model_v2', 'Base model_v2Pro', 'Base model_v2ProPlus']);
  assert.deepStrictEqual(out.sovits.map(e => e.version), ['v2', 'v2Pro', 'v2ProPlus']);
  assert.deepStrictEqual(out.sovits.map(e => e.default), [false, true, false]);
  assert.ok(out.sovits.every(e => e.builtin === true));
});

test('⭐⭐ GSV 每条声明的每个候选单独摆上台时，落下的就是那一条', () => {
  // 旧下拉靠 _BASE_SOVITS_DEFS 的回落顺序，摆在第几条就取第几条。
  // 只测「第一条候选在盘上」等于没测回退；这条按声明逐条摆。
  const profile = require('../engines/profile').resolveEngineProfile('gpt-sovits');
  const conv = require('../assetScanner/engineScan').readScanConventions('gpt-sovits');
  for (const decl of conv.base_models) {
    for (const rel of decl.candidates) {
      const root = tmp();
      const ck = path.join(root, profile.runtime.checkpoints);
      touch(path.join(ck, rel));
      const out = baseModelsForEngine(profile, { appDir: root, env: {} })[decl.slot];
      assert.equal(out.length, 1, `${rel} 应该只落出一条候选`);
      assert.equal(out[0].path, posix(path.join(ck, rel)),
        `盘上只有 ${rel}，选中的必须是它`);
      assert.equal(out[0].name, decl.name);
    }
  }
});

// ── 批量：逐台隔离，说不出来的那台要说清为什么 ──────────────────────────

test('⭐⭐ 两台引擎的底模按引擎分组，形状与角色资产那侧完全一致', () => {
  const a = tmp(); touch(path.join(a, 'encoder', 'enc.bin')); touch(path.join(a, 'decoder', 'dec.bin'));
  const b = tmp(); touch(path.join(b, 'config.yaml'));
  const out = baseModelsByEngine([
    fakeProfile('enginea', ENC_DEC, a),
    fakeProfile('engineb', [{ name: 'model', label: 'M' }], b),
  ], {});
  assert.deepStrictEqual(Object.keys(out.models).sort(), ['enginea', 'engineb']);
  assert.strictEqual(out.models.enginea.encoder.length, 1);
  assert.strictEqual(out.models.engineb.model.length, 1, '没有官方微调路径的引擎照样有底模候选');
  assert.deepStrictEqual(out.missing, []);
});

test('一台引擎的 scan.json 写坏，只让它自己说不出来，别照常列，报错原文带出去', () => {
  const b = tmp(); touch(path.join(b, 'model', 'base.safetensors'));
  const out = baseModelsByEngine([
    fakeProfile('broken-base', ENC_DEC, tmp()),
    fakeProfile('bare-base', [{ name: 'model', label: 'M' }], b),
  ], {});
  assert.ok(out.models['bare-base'], '坏的那台不许连累别台');
  assert.strictEqual(out.models['bare-base'].model.length, 1);
  assert.equal(out.models['broken-base'], undefined);
  assert.equal(out.missing.length, 1);
  assert.equal(out.missing[0].engine_id, 'broken-base');
  assert.equal(out.missing[0].reason, 'invalid');
  assert.match(out.missing[0].message, /candidate/, '要说清坏在哪个键上');
});

test('目录里有底模、候选却一条都报不出来 ⇒ 报「缺的是 scan.json」', () => {
  // GSV 的底模目录长这样：v2/ v2Pro/ 一层层按版本分，不按权重位分。
  // 名片写了两个位、盘上有文件，通用规则报不出候选；这台又没 scan.json（旧拷贝、
  // 外部 ENGINES_DIR 就是这个样子），下拉于是从「有」变成「空」⇒ 这个原因要说出来。
  const root = tmp();
  touch(path.join(root, 'v2', 'enc.bin'));
  touch(path.join(root, 'v2Pro', 'dec.bin'));
  const out = baseModelsByEngine([
    fakeProfile('no-scan-base', ENC_DEC, root),
  ], {});
  assert.deepStrictEqual(out.models, { 'no-scan-base': { encoder: [], decoder: [] } },
    '位还在、值是空数组：和「没有这个位」是两件事');
  assert.deepStrictEqual(out.missing, [{ engine_id: 'no-scan-base', reason: 'no_scan_file' }]);
});

test('底模目录是空的 ⇒ 不报 scan.json：那是「还没下底模」，另有提示', () => {
  const out = baseModelsByEngine([fakeProfile('no-scan-base', ENC_DEC, tmp())], {});
  assert.deepStrictEqual(out.missing, []);
});

test('盘上有分层目录时不报「没写 scan.json」：通用规则已经把候选报出来了', () => {
  const root = tmp();
  touch(path.join(root, 'encoder', 'enc.bin'));
  const out = baseModelsByEngine([fakeProfile('no-scan-base', ENC, root)], {});
  assert.deepStrictEqual(out.missing, []);
  assert.strictEqual(out.models['no-scan-base'].encoder.length, 1);
});

test('名片没说底模在哪的引擎不算「说不出来」：它本来就没有底模', () => {
  const p = fakeProfile('no-scan-base', ENC, tmp());
  p.runtime = {};
  assert.deepStrictEqual(baseModelsByEngine([p], {}).missing, []);
});

test('一台引擎的名片坏了，不影响别台（fail-open 到格子，不是到整张表）', () => {
  const b = tmp(); touch(path.join(b, 'config.yaml'));
  const out = baseModelsByEngine([
    null,
    { id: 'broken' },                                   // 没有 weight_slots
    fakeProfile('engineb', [{ name: 'model', label: 'M' }], b),
  ], {});
  assert.ok(out.models.engineb, '好的那台必须还在');
  assert.strictEqual(out.models.engineb.model.length, 1);
});

test('⛔⛔ 平台代码里不许出现任何具体引擎 id 或权重位名', () => {
  // 出现了，就说明「给某台引擎单写一套」又回来了 ： 平台代码里不许有
  //  按引擎分叉的分支。
  const src = fs.readFileSync(path.join(__dirname, 'baseModels.js'), 'utf-8');
  const code = src.split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  for (const banned of ['gpt-sovits', 'indextts', 'GSV_', 'sovits', 'gpt.pth']) {
    assert.ok(!code.includes(banned), `baseModels.js 的代码里出现了 ${banned}`);
  }
});
