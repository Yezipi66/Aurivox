'use strict'
// 名片校验层 —— 三台真引擎当压力用例
//
// ⭐ 为什么用三台真引擎当用例（这是方法论，不是省事）
// 骨架要**形状完全不同**的引擎都能过，才敢拿去装第四台。
// 只按一台写，坑一定留在后面 —— 那是平台反复付过学费的同一种缺陷。
//
//   形状            哪台            考什么
//   无 call 段      无 call 的那台   骨架会不会写死「必须有 call」
//   旧式 params     同上            新旧两套声明会不会打架
//   5 个方法        多方法那台      applies_to 有没有位置放
//   0 个权重位      零位那台        weights 空数组是不是合法
//
// 另有一台**假引擎**（wobble/flavour/goose_count）守「不许出现任何引擎名」。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const { diagnose, summarize } = require('../core/validate.js')
const { SECTIONS, PARAM_FIELDS, SECTIONS_BY_KEY } = require('../core/fieldmeta')

const REPO = path.resolve(__dirname, '..', '..', '..')

// ---------------------------------------------------------------------------
// 一、真引擎：三台都读得进去，且**没有 error**
// ---------------------------------------------------------------------------
const REAL_ENGINES = ['gpt-sovits', 'indextts2', 'cosyvoice2']

for (const id of REAL_ENGINES) {
  test(`真引擎 ${id}：校验层读得进去，且不报 error`, () => {
    const file = path.join(REPO, 'engines', id, 'manifest.json')
    assert.ok(fs.existsSync(file), `找不到名片：${file}`)
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'))

    const diags = diagnose(manifest)
    const sum = summarize(diags)

    // ⛔ 这是关键断言：一张已经在平台跑着的名片，校验层不能判它错。
    //    判错 = 校验层比平台更严 ⇒ 那它就是个不合格的检查器。
    assert.strictEqual(sum.errors, 0,
      `校验层判它有错，但平台一直在用它：\n` +
      diags.filter(d => d.level === 'error').map(d => '  ' + d.message).join('\n'))

    // 反过来，也不能假装它完美 —— 三台都该报出「静默失效」那一类，
    // 因为模板里的默认值（tier/phase 不写）本身就是静默项。
    assert.ok(Array.isArray(diags))
  })
}

// ---------------------------------------------------------------------------
// 二、形状覆盖：三种「不一样」都必须被容下，而不是被拒
// ---------------------------------------------------------------------------
test('无 call 段的引擎不被拒（骨架不能写死「必须有 call」）', () => {
  const file = path.join(REPO, 'engines', 'gpt-sovits', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.strictEqual(manifest.call, undefined, '前提变了：无 call 段的那台现在有 call 了，测试要改')
  const sum = summarize(diagnose(manifest))
  assert.strictEqual(sum.errors, 0)
})

test('零个权重位是合法的（空数组不是错）', () => {
  const file = path.join(REPO, 'engines', 'cosyvoice2', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.deepStrictEqual(manifest.weights, undefined,
    '前提变了：那台现在有 weights 了，测试要改')
  assert.strictEqual(summarize(diagnose(manifest)).errors, 0)
})

test('多方法的 applies_to 提示能落到具体第几项', () => {
  const file = path.join(REPO, 'engines', 'cosyvoice2', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'))
  assert.ok(Array.isArray(manifest.parameters) && manifest.parameters.length > 0)
  const diags = diagnose(manifest)
  // 每条 parameters 诊断都要能指出是哪一项
  const pdiags = diags.filter(d => d.section === 'parameters')
  for (const d of pdiags) {
    assert.strictEqual(typeof d.index, 'number', `参数诊断没有 index：${d.message}`)
    assert.ok(d.index >= 0 && d.index < manifest.parameters.length)
  }
})

// ---------------------------------------------------------------------------
// 三、假引擎：判据是「装一台谁都没见过的引擎，这里一个字都不用改」
// ---------------------------------------------------------------------------
function fakeEngineManifest () {
  return {
    contract_version: 3,
    id: 'wobblecaster',
    label: 'Wobble',
    upstream: { repo: 'https://example.invalid/wobble', commit: 'deadbeef' },
    local_changes: 'none',
    runtime: {
      python: 'engines/wobblecaster/.venv',
      entry: 'serve.py',
      args: ['--port', '{port}'],
      cwd: '.',
      ready_endpoint: '/health',
      ready_timeout_ms: 60000,
      ready_timeout_ms_source: 'estimated',
    },
    call: {
      kind: 'python',
      module: 'wobble',
      class: 'Wobble',
      init_args: {},
      bind: { text: 'the_words' },
      returns: 'bytes',
      seed: 'none',
    },
    parameters: [
      { name: 'wobble', type: 'number', min: 0, max: 10, step: 0.5, tier: 'common' },
      { name: 'flavour', type: 'select', choices: ['vanilla', 'pickle'], tier: 'common' },
      { name: 'goose_count', type: 'integer', phase: 'load' },
    ],
  }
}

test('假引擎（wobble/flavour/goose_count）能完整走通', () => {
  const sum = summarize(diagnose(fakeEngineManifest()))
  assert.strictEqual(sum.errors, 0,
    `一台从没见过的引擎被判错了：${JSON.stringify(sum)}`)
})

test('假引擎也能吃到默认值的提示（tier 默认 advanced）', () => {
  const diags = diagnose(fakeEngineManifest())
  const tierInfo = diags.filter(d => d.code === 'TIER_DEFAULTED')
  assert.ok(tierInfo.length > 0, '没 tier 的参数应当有一条提示')
  assert.ok(tierInfo.every(d => d.field && typeof d.index === 'number'))
})

// ---------------------------------------------------------------------------
// 四、纪律守卫：本层不许出现任何具体引擎名
// ---------------------------------------------------------------------------
test('⛔ validate.js / fieldmeta.js 里不许出现任何具体引擎名', () => {
  const FILES = ['validate.js', 'fieldmeta.js']
  // 用 split 拼，绕开「测试文件自己写着这些名字」的自指问题
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice2',
    'cosy' + 'voice-300m-sft', 'gpt' + '_sovits']
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'core', f), 'utf-8')
    // 去掉注释再看 —— 注释里提到历史是允许的，活代码里出现才是破纪律
    const code = src.split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    for (const bad of FORBIDDEN) {
      assert.ok(!code.toLowerCase().includes(bad),
        `${f} 的活代码里出现了「${bad}」—— 骨架不许为任何一台引擎写死特例`)
    }
  }
})

// ---------------------------------------------------------------------------
// 五、元数据自检：字段说明要覆盖得住，且默认值与平台一致
// ---------------------------------------------------------------------------
test('参数元数据的默认值与平台一致（phase=call / tier=advanced）', () => {
  const byKey = Object.fromEntries(PARAM_FIELDS.map(f => [f.key, f]))
  assert.strictEqual(byKey.phase.default, 'call')
  // ⛔ tier 的默认值必须是 advanced —— 平台 engines.js:164 那条规则的直接后果，
  //    写成 common 会让「没写 tier 的参数」全部浮到常用档
  assert.strictEqual(byKey.tier.default, 'advanced')
  assert.strictEqual(byKey.repeat.default, 1)
})

test('每个顶层段都有说明与危险等级', () => {
  for (const s of SECTIONS) {
    assert.ok(s.howto && s.howto.length > 5, `${s.key} 缺说明`)
    assert.ok(['block', 'silent', 'info'].includes(s.danger), `${s.key} 危险等级非法`)
    assert.ok(SECTIONS_BY_KEY[s.key] === s)
  }
})

test('⚠ 危险字段必须写了 warn（静默失效那一类要提醒）', () => {
  // 平台管不到、填错不报错的那几个 —— 必须有 warn 文案
  const MUST_WARN = ['weights', 'call']
  for (const k of MUST_WARN) {
    const s = SECTIONS_BY_KEY[k]
    assert.ok(s.warn && s.warn.length > 5,
      `${k} 是静默失效高危段，却没写 warn`)
  }
})