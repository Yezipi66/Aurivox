'use strict';

// ---------------------------------------------------------------------------
//  刀 A2 的验收测试：整音色路径挑权重，⛔ 不许认识任何一台引擎
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 这个文件存在的唯一理由：
//   A2 改的那段代码，**今天在真机上跑，改前改后一模一样** ——
//   因为盘上只有 GPT-SoVITS 一台带权重位的引擎，写死 `"gpt-sovits"` 恰好是对的。
//   ⇒ 只靠现有测试，A2 是一刀**无法证伪**的改动，等于没做。
//
// ⇒ 下面每一条都用一台**盘上不存在的假引擎**，位名和 param 都取成
//   跟 GPT-SoVITS 毫无关系的字样。老写法在这些用例上必红。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { pickSlotWeights } = require('./slotPicks');

/** 平台既有的挑选顺序：这里只要"拿第一个"，A2 不改挑选规则。 */
const pickFirst = (list) => list[0];

/** 一台盘上不存在的引擎：两个位，位名/param 与 GSV 无一相同。 */
function fakeEngine() {
  return {
    id: 'nebula-tts',
    weight_slots: [
      { name: 'acoustic', param: 'acoustic_weight' },
      { name: 'vocoder', param: 'vocoder_weight' },
    ],
  };
}

function fakeMeta() {
  return {
    assets: {
      models: {
        'nebula-tts': {
          acoustic: [{ name: 'a.bin', path: 'D:\\x\\acoustic\\a.bin' }],
          vocoder: [{ name: 'v.bin', path: 'D:\\x\\vocoder\\v.bin' }],
        },
      },
    },
  };
}

test('⭐⭐⭐ 一台盘上不存在的引擎，两个位都按名片的 param 名填上', () => {
  const picks = pickSlotWeights(fakeEngine(), fakeMeta(), pickFirst);
  assert.deepStrictEqual(picks, {
    acoustic_weight: 'D:\\x\\acoustic\\a.bin',
    vocoder_weight: 'D:\\x\\vocoder\\v.bin',
  });
});

test('⛔ 不许再冒出 gpt_model / sovits_model 这两个键', () => {
  const picks = pickSlotWeights(fakeEngine(), fakeMeta(), pickFirst);
  // 老写法（写死 gpt-sovits + 两个固定键）在这台引擎上会产出这两个键
  // 且值为空 —— 那正是「平台替引擎作答」的形状。
  assert.ok(!('gpt_model' in picks), 'gpt_model 不该存在');
  assert.ok(!('sovits_model' in picks), 'sovits_model 不该存在');
  assert.strictEqual(Object.keys(picks).length, 2);
});

test('⭐⭐ 名片没写 param 的位 ⇒ 一个键都不发（⛔ 不许悄悄发一个没人读的键）', () => {
  const eng = fakeEngine();
  delete eng.weight_slots[1].param;          // vocoder 位：能列候选，但换不了
  const picks = pickSlotWeights(eng, fakeMeta(), pickFirst);
  assert.deepStrictEqual(picks, { acoustic_weight: 'D:\\x\\acoustic\\a.bin' });
  // ⛔ 尤其不许发成空串 —— 空串在 payload.js:63 的 isSendable 那里会被滤掉，
  //    看起来"没事"，但键存在本身就是一句谎（说"我给你选了一份"）。
  assert.ok(!('vocoder_weight' in picks));
});

test('⭐ meta 里没有这台引擎的模型 ⇒ 空表，⛔ 不抛、⛔ 不返回空串', () => {
  const meta = { assets: { models: { 'some-other-engine': { x: [{ path: 'p' }] } } } };
  assert.deepStrictEqual(pickSlotWeights(fakeEngine(), meta, pickFirst), {});
});

test('⭐ 某个位有候选、另一个没有 ⇒ 只填有的那个', () => {
  const meta = fakeMeta();
  delete meta.assets.models['nebula-tts'].vocoder;
  const picks = pickSlotWeights(fakeEngine(), meta, pickFirst);
  assert.deepStrictEqual(picks, { acoustic_weight: 'D:\\x\\acoustic\\a.bin' });
});

test('挑中的那份没有 path ⇒ 不填（⛔ 不填 undefined 进去）', () => {
  const picks = pickSlotWeights(fakeEngine(), fakeMeta(), () => ({ name: 'x' }));
  assert.deepStrictEqual(picks, {});
});

test('pickBest 返回 null / 引擎没有 weight_slots / meta 为空 ⇒ 都不炸', () => {
  assert.deepStrictEqual(pickSlotWeights(fakeEngine(), fakeMeta(), () => null), {});
  assert.deepStrictEqual(pickSlotWeights({ id: 'x' }, fakeMeta(), pickFirst), {});
  assert.deepStrictEqual(pickSlotWeights(fakeEngine(), null, pickFirst), {});
  assert.deepStrictEqual(pickSlotWeights(null, fakeMeta(), pickFirst), {});
});

test('⭐⭐⭐ 三台引擎轮流点名，同一份 meta 各自只拿到自己那几份', () => {
  const meta = {
    assets: {
      models: {
        'nebula-tts': { acoustic: [{ path: 'N-a' }], vocoder: [{ path: 'N-v' }] },
        'quasar': { whole: [{ path: 'Q-w' }] },
        'pulsar': { acoustic: [{ path: 'P-a' }] },
      },
    },
  };
  const engs = [
    fakeEngine(),
    { id: 'quasar', weight_slots: [{ name: 'whole', param: 'ckpt' }] },
    { id: 'pulsar', weight_slots: [{ name: 'acoustic', param: 'acoustic_weight' }] },
  ];
  assert.deepStrictEqual(pickSlotWeights(engs[0], meta, pickFirst),
    { acoustic_weight: 'N-a', vocoder_weight: 'N-v' });
  assert.deepStrictEqual(pickSlotWeights(engs[1], meta, pickFirst), { ckpt: 'Q-w' });
  assert.deepStrictEqual(pickSlotWeights(engs[2], meta, pickFirst), { acoustic_weight: 'P-a' });
});

// ---------------------------------------------------------------------------
//  归零守卫
// ---------------------------------------------------------------------------

test('⛔ slotPicks.js 的代码里不许出现任何一台引擎的 id 或位名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'slotPicks.js'), 'utf-8');
  const code = src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))   // 注释里可以举例，代码里不行
    .join('\n');
  for (const bad of ['gpt-sovits', 'gpt_sovits', 'indextts', 'sovits', 'gpt_model']) {
    assert.ok(!code.includes(bad), `slotPicks.js 的代码里出现了 ${bad}`);
  }
});

test('⛔ routes/synthesis.js 的代码里不许再写死引擎名（A2 归零判据）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'synthesis.js'), 'utf-8');
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;      // 整行注释（含墓碑）放行
    if (/["']gpt-sovits["']|["']gpt_sovits["']/.test(l)) hits.push(`${i + 1}: ${l.trim()}`);
  });
  assert.deepStrictEqual(hits, [], `synthesis.js 还有写死的引擎名：\n${hits.join('\n')}`);
});
