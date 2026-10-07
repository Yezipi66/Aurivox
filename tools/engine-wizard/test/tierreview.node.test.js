'use strict'
// 档位复核 ——拿真引擎的 tier 分布当基线
//
// ⭐ 这个测试的设计意图
//   复核规则是「名字启发」，听起来很玄。唯一的验法是：
//   **把真引擎的参数喂进去，看它判得对不对。**
//   对得上 ⇒ 启发抓到了真规律；对不上 ⇒ 这层是噪声，该删。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const { reviewTier, reviewTiers, ADVANCED_HINTS } = require('../core/tierreview.js')
const { paramSamples, allParamNames, fieldSamples, tierDistribution, listEngineIds } =
  require('../core/instances.js')

// ---------------------------------------------------------------------------
// 一、真引擎基线：常见度启发对不对得上
// ---------------------------------------------------------------------------
test('真引擎里那些「明显是进阶」的参数，都被启发判成 advanced', () => {
  // ⛔ 这些名字从真名片里取（见 instances.paramSamples），
  //   但**判定逻辑**里不许出现引擎名 —— 那是 algorithms 的纪律。
  const CASES = [
    // 调试开关
    ['verbose', 'advanced'], ['use_random', 'advanced'],
    // 性能开关（phase=load）
    ['use_fp16', 'advanced'], ['use_cuda_kernel', 'advanced'],
    ['use_deepspeed', 'advanced'], ['use_accel', 'advanced'],
    ['use_torch_compile', 'advanced'],
    // 分段控制
    ['max_text_tokens_per_segment', 'advanced'],
    // 常用项（这些真引擎里是 common）
    ['emo_alpha', null],          // 情绪强度 = 常用（但名字看不出 ⇒ 不给建议）
    ['interval_silence', null],   // 段间静音 = 常用（同样看不出）
  ]
  for (const [name, expect] of CASES) {
    const r = reviewTier({ name, phase: 'call' })
    if (expect === null) {
      assert.strictEqual(r.tier, null,
        `${name} 应留空让人定，实际给了「${r.tier}」（${r.why}）`)
      assert.strictEqual(r.source, '不定')
    } else {
      assert.strictEqual(r.tier, expect,
        `${name} 应判成 ${expect}，实际 ${r.tier}（来源「${r.source}」）`)
    }
  }
})

test('phase=load 一律 advanced（强先验，三台真引擎全部如此）', () => {
  // 拿真引擎的 load 参数逐个验
  const loadNames = []
  for (const id of listEngineIds()) {
    const m = JSON.parse(fs.readFileSync(
      path.join(path.resolve(__dirname, '..', '..', '..'), 'engines', id, 'manifest.json'),
      'utf-8'))
    if (!Array.isArray(m.parameters)) continue
    for (const p of m.parameters) {
      if (p && p.phase === 'load') loadNames.push(p.name)
    }
  }
  assert.ok(loadNames.length > 0, '三台真引擎里一个 phase=load 的参数都没有？')
  for (const n of loadNames) {
    const r = reviewTier({ name: n, phase: 'load' })
    assert.strictEqual(r.tier, 'advanced', `${n} 是 load 却没判成 advanced`)
    assert.strictEqual(r.source, '先验')
  }
})

test('真引擎里 phase=call 的 tier 分布确实是「少数 common」（启发的前提）', () => {
  const d = tierDistribution('call')
  const total = d.distribution.common + d.distribution.advanced
  assert.ok(total > 0, '没有可比的 call 参数')
  // ⛔ 这条是本层的**前提假设**：若真引擎其实都是 common，
  //   那「按名字启发挑少数几个进common」就是错的策略。
  assert.ok(d.distribution.advanced > d.distribution.common,
    `真引擎的 call 参数里 advanced(${d.distribution.advanced}) ` +
    `应当多于 common(${d.distribution.common}) —— 若不是，启发的前提不成立`)
})

// ---------------------------------------------------------------------------
// 二、⛔ 最关键的一条：不得覆盖人已经填的
// ---------------------------------------------------------------------------
test('人已经写了 tier，复核不覆盖它', () => {
  const ps = [{ name: 'verbose', tier: 'common' }, { name: 'emo_alpha' }]
  const r = reviewTiers(ps)
  assert.strictEqual(ps[0].tier, 'common', '覆盖了人填的值')
  assert.strictEqual(ps[0]._tier_review, undefined, '不该标记已经填过的')
  assert.strictEqual(r.reviewed, 0)
  assert.strictEqual(r.blank, 1)
})

test('没填的才被复核，且留空的标成「不定」而不是瞎填', () => {
  const ps = [{ name: 'emo_alpha' }]           // 名字看不出 → 留空
  const r = reviewTiers(ps)
  assert.strictEqual(ps[0].tier, undefined, '留空时不该硬填一个值')
  assert.strictEqual(ps[0]._tier_review.decided, false)
  assert.ok(ps[0]._tier_review.why.includes('进阶档'))
  assert.strictEqual(r.blank, 1)
  assert.strictEqual(r.reviewed, 0)
})

// ---------------------------------------------------------------------------
// 三、纪律守卫：算法侧不许出现引擎名
// ---------------------------------------------------------------------------
test('⛔ tierreview.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice']
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'tierreview.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad),
      `tierreview.js 活代码里出现了「${bad}」`)
  }
})

test('⛔ 启发词表是界面词汇，不是某台引擎的参数名', () => {
  // 每个词都该是「一种开关的作用」，而不是某个具体参数的全名
  for (const h of ADVANCED_HINTS) {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(h), `启发词「${h}」写法可疑`)
    // 不该长到像某个具体引擎的完整参数名（含 phase 语义的组合词）
    assert.ok(h.length <= 20, `启发词「${h}」太长，像具体参数名而非通用作用`)
  }
})

// ---------------------------------------------------------------------------
// 四、对照数据本身能用
// ---------------------------------------------------------------------------
test('对照实例：能按字段名查到各方怎么填', () => {
  for (const key of ['runtime', 'models', 'capabilities', 'call']) {
    const s = fieldSamples(key)
    assert.ok(s.total > 0, `没有任何引擎可比（${key}）`)
    // 字段存在性本身要与文件名册一致
    assert.strictEqual(s.samples.length, s.presentIn)
  }
})

test('对照实例：能按参数名查到各方怎么写', () => {
  const names = allParamNames()
  assert.ok(names.length > 0, '一张名片里连一个 parameters[] 都没有？')
  for (const { name } of names.slice(0, 5)) {
    const s = paramSamples(name)
    assert.ok(s.samples.length > 0, `参数 ${name} 查不到任何实例`)
    for (const { engine, entry } of s.samples) {
      assert.ok(engine && entry, '实例缺 engine 或 entry')
      assert.ok(!Object.keys(entry).some((k) => k.startsWith('_')),
        `实例里混进了注解键 ${Object.keys(entry).find((k) => k.startsWith('_'))}`)
    }
  }
})