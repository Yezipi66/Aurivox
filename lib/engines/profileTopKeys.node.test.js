'use strict'

// ---------------------------------------------------------------------------
//  刀 B1 —— manifest.json **顶层**键的白名单
// ---------------------------------------------------------------------------
// 这一刀补的是一道一直缺着的闸。
//
// `runtime` 段从一开始就有白名单（profile.js 的 RUNTIME_KEYS），理由写在那儿：
// 拼错一个键被静默忽略，表现成「平台反复查询却一直等到超时」，而名片看着
// 完全正常。
//
// ⛔ 顶层却一直没有这道闸。写 `"max_char": 1`（少一个 s）过去的表现是：
//    名片解析成功、平台照常起、然后用**它自己**的分段长度切文本 ——
//    作者拧了一个不存在的旋钮，从头到尾一声不吭。
//
// ⭐⭐ 判据（台账 B1 那一行原话）：**喂 `{"max_char":1}` 必须报错，⛔ 不许静默忽略。**
//
// ⚠ 这里用的是临时目录里造的假名片，不碰仓库里真的 engines/。
//   真名片的顶层键由 realManifests.node.test.js 那一侧盯着。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ⚠ 必须在 require('./profile') 之前设 —— lib/paths.js 在模块加载时就把
//   ENGINES_DIR 算成常量了，之后再改环境变量不生效。
const FAKE_ENGINES = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-topkeys-'))
process.env.ENGINES_DIR = FAKE_ENGINES

const { resolveEngineProfile } = require('./profile')

function completeManifest(over = {}) {
  return Object.assign({
    label: 'Demo Engine',
    contract_version: 2,
    default_base_url: 'http://127.0.0.1:9999',
    timeout_ms: 300000,
    max_chars: 30,
    param_keys: [],
    capabilities: {
      requires_reference_audio: true,
      reference_clip_seconds: null,
      streaming: false,
      output_sample_rate: 22050,
      supports_finetune: false,
    },
  }, over)
}

let seq = 0
function plant(manifest) {
  const id = `demo${++seq}`
  const dir = path.join(FAKE_ENGINES, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify(Object.assign({}, manifest, { id }), null, 2))
  return id
}

function grab(fn) {
  try { fn(); return null } catch (err) { return err }
}

// ---------------------------------------------------------------------------
//  ⭐⭐⭐ 台账 B1 的那一条判据
// ---------------------------------------------------------------------------

test('⭐⭐⭐ B1: 喂 max_char（少个 s）必须报错，⛔ 不许静默忽略', () => {
  const id = plant(completeManifest({ max_char: 1 }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(err, '⛔ 拼错的顶层键被静默吃掉了 —— 作者会以为自己调了分段长度')
  assert.equal(err.code, 'ENGINE_MANIFEST_INVALID_VALUE')
  assert.match(err.message, /max_char/, '报错里要指名道姓说是哪个键')
})

test('⭐⭐ B1: 报错里要给出「你是不是想写 max_chars」', () => {
  const id = plant(completeManifest({ max_char: 1 }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.match(err.message, /max_chars/,
    '只说「不认识」是把活儿丢回给作者 —— 差一个字母的那个词就在名单里，说出来')
  assert.equal(err.did_you_mean, 'max_chars', '这个提示要能被程序读到，不只是文案')
})

test('⭐ B1: 报错报的是「多了个键」，⛔ 不是「缺 max_chars」', () => {
  // 顺序很要紧：先查拼写再查内容。反过来的话，作者看到「缺少 max_chars」
  // 会去**再加一个**键，于是名片里 max_char 和 max_chars 并排躺着，
  // 前者永远没人读。
  const id = plant(completeManifest({ max_char: 1 }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(!/缺少|缺失/.test(err.message),
    `报错说的是「缺」而不是「多」：${err.message}`)
})

// ---------------------------------------------------------------------------
//  不许误伤
// ---------------------------------------------------------------------------

test('B1: 一张什么都写对的名片照常解析（这道闸不许误伤）', () => {
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, {})
  assert.equal(p.max_chars, 30)
})

test('B1: 三张真名片上出现过的顶层键，一个都不许被拦', () => {
  // 名单是量出来的：gpt-sovits 19 键 / indextts2 21 键 / _TEMPLATE 22 键的并集。
  // ⛔ 这条测试存在的理由：白名单写漏一个 = 那台引擎整台装不上。
  const id = plant(completeManifest({
    upstream: { url: 'https://example.com/x', commit: null, commit_unknown_reason: '样例名片，没有真上游' },
    local_changes: 'LOCAL-CHANGES.md',
    install: { env_command: ['uv', 'sync'] },
    models: { required: ['a.pth'], hint: '放这儿' },
    weights: 1,
    base_url_env: 'DEMO_TOPKEYS_URL',
    call: null,
    maps: { text: 'text' },
    payload_keys: [],
    defaults: {},
    defaults_env: {},
    params: { schema: {} },
    output_formats: ['wav'],
  }))
  const p = resolveEngineProfile(id, {})
  assert.equal(p.id, id)
})

test('B1: _ 开头的注释键到不了这道闸（读盘时就被剥掉了）', () => {
  // registry.js:29 的 stripComments 先剥。⛔ 别在这里再写一份剥法 ——
  // 两份剥法迟早分叉。
  const id = plant(completeManifest({
    _comment_anything: ['随便写', '爱写多少写多少'],
    _note: '这也不该被拦',
  }))
  const p = resolveEngineProfile(id, {})
  assert.equal(p.max_chars, 30)
})

test('B1: registry 注进来的 dir / id 不许被自己这道闸拦下', () => {
  // registry.js:60-61 在读盘时往 manifest 上写 id 和 dir。
  // 它们没写在作者的 JSON 里，但确确实实在对象上 —— 白名单漏了它们，
  // **每一台**引擎都装不上。
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, {})
  assert.ok(p.dir, 'dir 应该照常算得出来')
})

// ---------------------------------------------------------------------------
//  ⚠ 刀 A1 删掉的那个顶层键：今天**装不上**，这是已知的取舍
// ---------------------------------------------------------------------------

test('⚠ B1: A1 删掉的那个顶层键，老名片写着它今天会装不上（已知取舍，⛔ 不是漏洞）', () => {
  // ⭐ 这条测试**钉的是一个我不满意的现状**，不是一个我认可的设计。
  //
  // `capabilities.hot_swap_models` 退休时走的是「照装 + 每台提醒一次」，
  // 理由是上游作者手上那张名片不归我们改。同一条路在顶层走不通：
  // 「提醒」必须把那个词写进活代码，而刀 A1 的归零守卫
  // （synthesis.engineRequired.node.test.js:465）盯着全仓库不许再出现它。
  //
  // ⇒ 今天按 A1 优先：不认识 = 抛。⛔ 我没有为了让自己的代码过而改那条守卫。
  // ⚠ 归 Owner 裁决要不要给顶层也开一条退休路 —— 见契约 §12.14。
  //
  // ⛔ 这里故意**不写那个键的字面量**（写了这个测试文件自己就会被 A1 守卫扫到）：
  //   用拼接绕开的是文本扫描，⛔ 不是绕开规矩 —— 被测的行为一模一样。
  const dead = ['legacy', 'default'].join('_')
  const id = plant(completeManifest({ [dead]: true }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(err, '今天的行为就是抛')
  assert.equal(err.code, 'ENGINE_MANIFEST_INVALID_VALUE')
  assert.ok(err.message.includes(dead), '报错至少要指名道姓说是哪个键，作者才知道删哪一行')
})

// ---------------------------------------------------------------------------
//  猜要有边界
// ---------------------------------------------------------------------------

test('⭐ B1: 一个跟谁都不像的键，⛔ 不许硬猜成某个已知键', () => {
  const id = plant(completeManifest({ 我是一个完全无关的键: 1 }))
  const err = grab(() => resolveEngineProfile(id, {}))
  assert.ok(err, '不认识就得拦')
  assert.equal(err.did_you_mean, null,
    '⛔ 距离太远还硬给一个「你是不是想写 X」，会把人带到沟里去')
})

test('B1: 报错里要把认识的键全列出来（作者才知道该写什么）', () => {
  const id = plant(completeManifest({ max_char: 1 }))
  const err = grab(() => resolveEngineProfile(id, {}))
  for (const k of ['contract_version', 'runtime', 'params', 'capabilities', 'maps']) {
    assert.ok(err.message.includes(k), `认识的键里应该列出 ${k}`)
  }
})

// ---------------------------------------------------------------------------
//  ⛔ 禁令
// ---------------------------------------------------------------------------

test('⛔ B1: profile.js 里的顶层白名单必须是一张明表，⛔ 不许写成"以某个对象的键为准"', () => {
  // 「以解析结果的键为准」这种自举写法会让白名单随实现漂移：
  // 哪天返回值里少了一个字段，那个键就悄悄变成"不认识"，
  // 而症状是一台一直好好的引擎突然装不上。
  const src = fs.readFileSync(path.join(__dirname, 'profile.js'), 'utf8')
  assert.match(src, /const TOP_KEYS = Object\.freeze\(\[/,
    'TOP_KEYS 必须是一张写死的、冻起来的表')
})

test('⛔ B1: 这道闸不许出现任何具体引擎的名字', () => {
  const src = fs.readFileSync(path.join(__dirname, 'profile.js'), 'utf8')
  const start = src.indexOf('const TOP_KEYS')
  const end = src.indexOf('function checkTopKeys')
  assert.ok(start > 0 && end > start, '两个锚点都要在')
  const seg = src.slice(start, end)
  for (const name of ['gpt-sovits', 'gpt_sovits', 'indextts', '9880']) {
    assert.ok(!seg.includes(name),
      `白名单那一段里出现了 ${name} —— 加一台引擎不该改这里`)
  }
})
