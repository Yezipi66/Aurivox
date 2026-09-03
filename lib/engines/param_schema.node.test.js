'use strict'

// ---------------------------------------------------------------------------
//  params.schema —— 契约 §5.4 的解析，以及 C11「参数表只有一份」的强制
// ---------------------------------------------------------------------------
// 这一组测试盯着的不是「解析对不对」，是**那份表会不会又变成两份**。
// C11（契约 §8:590）说得很直白：三份副本的问题不是重复，是它们会各自
// 漂移，而漂移不会报错 —— 只会表现为「说明书写的和界面上的不一样」。
//
// 实测已经漂过一次：batch_size 名片写 4（我们自己的调优决策，还配了
// AURIVOX_TTS_BATCH_SIZE 旋钮），前端 GenerateTab.jsx 写死 1 且无条件
// 发出去 ⇒ 那个 4 和那个旋钮在 webui 路径上从来没生效过。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveEngineProfile, parseParamSchema } = require('./profile')

// -- 真名片 -----------------------------------------------------------------

test('C11: 界面要的每一样都来自名片 —— 类型 / 范围 / 步长 / 分层，一个不缺', () => {
  const p = resolveEngineProfile('gpt-sovits', {})
  const byName = new Map(p.param_schema.map(s => [s.name, s]))

  const topK = byName.get('top_k')
  // 2026-08-29 收口成五种样式之后，名片里写的 'integer' 折进 'number'，
  // 「是不是整数」降级成条目上的 int 标记 —— ⭐ 两条都要验：
  // 只验 type 会漏掉「int 那一味丢了」，而丢了它 7.5 会被悄悄发给一台
  // 只吃整数的引擎，一路不报错。
  assert.equal(topK.type, 'number')
  assert.equal(topK.int, true, 'integer 的那一味丢了 —— 收取侧就不会 parseInt 了')
  assert.equal(topK.min, 1)
  assert.equal(topK.max, 100)
  assert.equal(topK.step, 1)
  assert.equal(topK.tier, 'common')
  assert.equal(topK.default, 15)

  // 逐字对得上搬家前 GenerateTab.jsx:824 那一行，否则就是搬漏了
  const steps = byName.get('sample_steps')
  assert.equal(steps.min, 4)
  assert.equal(steps.max, 64)
  assert.equal(steps.step, 4)
  assert.equal(steps.default, 32)
  assert.equal(steps.tier, 'advanced')
})

test('C11: 下拉框的选项也在名片里 —— 平台不认识 cut0..cut5 是什么意思', () => {
  const p = resolveEngineProfile('gpt-sovits', {})
  const m = p.param_schema.find(s => s.name === 'text_split_method')
  // 名片里写的仍是老词 'enum'，出口是五种样式里的 'select'（见 paramTypes.js）
  assert.equal(m.type, 'select')
  assert.deepEqual(m.choices.map(c => c.value), ['cut0', 'cut1', 'cut2', 'cut3', 'cut4', 'cut5'])
  assert.equal(m.default, 'cut5')
})

test('⭐ C11 的正收益：环境变量旋钮现在真能拧动界面初值', () => {
  // 搬家前：名片写 4、旋钮能拧，但前端 useState(1) 无条件发 1 ⇒ 两者都白搭。
  assert.equal(resolveEngineProfile('gpt-sovits', {}).param_schema
    .find(s => s.name === 'batch_size').default, 4)
  assert.equal(resolveEngineProfile('gpt-sovits', { AURIVOX_TTS_BATCH_SIZE: '2' }).param_schema
    .find(s => s.name === 'batch_size').default, 2)
})

test('sends_always 已退役：profile 不再生成这个字段', () => {
  const p = resolveEngineProfile('gpt-sovits', {})
  const byName = new Map(p.param_schema.map(s => [s.name, s]))
  // f68421f：未触碰的 UI 建议值不再跨越引擎边界，只有 touchedParams 记录过
  // 的键才发送。defaults 里的值仍由后端 engineKnobs 循环填入 payload。
  // profile 不再生成 sends_always —— 它没有消费者了。
  assert.equal(byName.get('batch_size').sends_always, undefined)
  assert.equal(byName.get('sample_steps').sends_always, undefined)
})

test('⚠ 平台自己的词不归任何引擎描述 —— 它们不在 schema 里', () => {
  const p = resolveEngineProfile('gpt-sovits', {})
  const names = p.param_schema.map(s => s.name)
  // 两张名片都有的 8 个平台词 + seed（IndexTTS2 用 maps 映射它）
  for (const platformWord of ['format', 'split', 'max_chars', 'concat',
    'silence_ms', 'media_type', 'engine_batch', 'voice_label', 'seed']) {
    assert.ok(!names.includes(platformWord),
      `${platformWord} 是平台自己的词，写进某台引擎的 schema 就等于说「它归这台引擎管」`)
  }
})

test('没写 params.schema 的引擎照样能用 —— 这一节是可选的', () => {
  // ⚠ 这条原本拿盘上那台「还没写 schema」的真引擎当样本
  //   （assert.deepEqual(resolveEngineProfile('indextts2').param_schema, [])）。
  //   那不是在测这条规矩，是在**给一张名片的当前内容拍照** —— 名片作者把
  //   那一节补上（正该补），这条测试就红，而红的原因跟它的名字毫无关系。
  //   ⇒ 改成造名片。规矩是「schema 这一节可以不写」，跟盘上装了谁无关。
  assert.deepEqual(parseParamSchema({ id: 'fake-engine', params: {} }, {}), [])
  assert.deepEqual(parseParamSchema({ id: 'fake-engine' }, {}), [])
})

// -- 造名片：把该抛的都抛出来 ------------------------------------------------

// ⚠ 这里不造假引擎目录：engines/ 那一层有目录清点守卫
// （registry.node.test.js:60 拿盘上目录和白名单逐个对），往里塞个
// fake-engine 会把它踩红。而且 ENGINES_DIR 是 require 时就冻住的常量，
// 改环境变量也晚了。⇒ 直接调解析函数，把名片当普通对象喂进去。
function withManifest(patch, fn) {
  const manifest = {
    id: 'fake-engine',
    param_keys: ['knob'],
    params: patch.params,
  }
  return fn(() => ({ param_schema: parseParamSchema(manifest, patch.defaults || {}) }))
}

test('⛔ C11: 两处都写默认值 ⇒ 当场抛，不许有第二份副本', () => {
  withManifest({
    defaults: { knob: 5 },
    params: { schema: { knob: { type: 'integer', default: 7 } } },
  }, run => {
    assert.throws(run, err => {
      assert.equal(err.code, 'ENGINE_MANIFEST_INVALID_VALUE')
      assert.match(err.message, /只能二选一/)
      return true
    })
  })
})

test('⛔ 两处都不写默认值 ⇒ 也抛（否则界面自己编一个，副本又回来了）', () => {
  withManifest({
    defaults: {},
    params: { schema: { knob: { type: 'integer' } } },
  }, run => {
    assert.throws(run, err => {
      assert.equal(err.code, 'ENGINE_MANIFEST_INCOMPLETE')
      return true
    })
  })
})

test('⛔ schema 里冒出 param_keys 没有的名字 ⇒ 抛（界面会长出一个发不出去的格子）', () => {
  withManifest({
    defaults: { ghost: 1 },
    params: { schema: { ghost: { type: 'integer' } } },
  }, run => {
    assert.throws(run, err => {
      assert.match(err.message, /param_keys 里没有它/)
      return true
    })
  })
})

test('⛔ type 写错 ⇒ 抛，并列出认得的几种（界面靠它决定长出哪种控件）', () => {
  withManifest({
    defaults: { knob: 1 },
    params: { schema: { knob: { type: 'slider' } } },
  }, run => {
    assert.throws(run, err => {
      assert.equal(err.code, 'ENGINE_MANIFEST_INVALID_VALUE')
      assert.match(err.message, /number/)
      return true
    })
  })
})

test('⛔ enum 的 default 不在 choices 里 ⇒ 抛（界面会显示一个选不中的值）', () => {
  withManifest({
    defaults: { knob: 'c' },
    params: { schema: { knob: { type: 'enum', choices: [{ value: 'a' }, { value: 'b' }] } } },
  }, run => {
    assert.throws(run, err => {
      assert.match(err.message, /不在 choices 里/)
      return true
    })
  })
})

test('⛔ min 比 max 还大 ⇒ 抛', () => {
  withManifest({
    defaults: { knob: 1 },
    params: { schema: { knob: { type: 'integer', min: 10, max: 2 } } },
  }, run => {
    assert.throws(run, err => {
      assert.match(err.message, /比 max/)
      return true
    })
  })
})

test('tier 没写按 advanced —— 少露一个格子比多露一个安全', () => {
  withManifest({
    defaults: { knob: 1 },
    params: { schema: { knob: { type: 'integer' } } },
  }, run => {
    assert.equal(run().param_schema[0].tier, 'advanced')
  })
})

test('⚠ 平台不许认识任何一个参数名（契约 §5.5）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'profile.js'), 'utf8')
  // 拿真名片里的键名去搜解析器源码：一个都不许出现。
  const real = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'engines', 'gpt-sovits', 'manifest.json'), 'utf8'))
  const names = Object.keys(real.params.schema)
  // 注释里可以提，代码里不行 —— 只看去掉注释之后的部分。
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  const leaked = names.filter(n => code.includes(`'${n}'`) || code.includes(`"${n}"`))
  assert.deepEqual(leaked, [],
    '解析器一旦认识某个具体参数名，那台引擎的特殊性就永久留在平台层了')
})
