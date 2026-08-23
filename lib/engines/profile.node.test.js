'use strict'

// ---------------------------------------------------------------------------
//  lib/engines/profile.js —— 名片解析
// ---------------------------------------------------------------------------
// 这些测试用的是**临时目录里造的假名片**，不碰仓库里真的 engines/。
// 原因：真名片会随业务变（有一天 max_chars 从 30 调到 25 是完全合理的），
// 那时候不该有一堆测试跟着红。真名片的正确性由本文件最后一段
// 「真名片体检」负责，那部分只判「读得出来、不抛」，不锁具体数值。
//
// ⚠ ENGINES_DIR 必须在 require 之前设好 —— lib/paths.js 在模块加载时就
//   把它算成常量了，之后再改环境变量不会生效。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FAKE_ENGINES = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-profile-'))
process.env.ENGINES_DIR = FAKE_ENGINES

const { resolveEngineProfile } = require('./profile')

// 一张「什么都写全了」的名片，各条测试在它基础上删/改一项。
function completeManifest(over = {}) {
  return Object.assign({
    id: 'demo',
    label: 'Demo Engine',
    contract_version: 2,
    default_base_url: 'http://127.0.0.1:9999',
    timeout_ms: 300000,
    max_chars: 30,
    param_keys: ['format', 'split'],
    capabilities: Object.assign({
      hot_swap_models: false,
      requires_reference_audio: true,
      reference_clip_seconds: null,
      streaming: false,
      output_sample_rate: 22050,
      supports_finetune: false,
    }, over.capabilities || {}),
  }, (() => { const o = Object.assign({}, over); delete o.capabilities; return o })())
}

// 把一张名片落到临时目录里，返回引擎 id。`mutate` 可以删键。
let seq = 0
function plant(manifest, mutate) {
  const id = `demo${++seq}`
  const dir = path.join(FAKE_ENGINES, id)
  fs.mkdirSync(dir, { recursive: true })
  const m = Object.assign({}, manifest, { id })
  if (mutate) mutate(m)
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2))
  return id
}

// ---------------------------------------------------------------------------
//  读得出来
// ---------------------------------------------------------------------------

test('名片写全时，六件事都读得出来', () => {
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, {})
  assert.equal(p.base_url, 'http://127.0.0.1:9999')
  assert.equal(p.base_url_source, 'manifest')
  assert.equal(p.timeout_ms, 300000)
  assert.equal(p.max_chars, 30)
  assert.equal(p.hot_swap_models, false)
  assert.equal(p.output_sample_rate, 22050)
  assert.equal(p.requires_reference_audio, true)
  assert.equal(p.reference_clip_seconds, null)
})

test('硬上限 = 软上限 ×2（和搬家前 synthesisService 的算法一致）', () => {
  const id = plant(completeManifest({ max_chars: 20 }))
  assert.equal(resolveEngineProfile(id, {}).hard_max_chars, 40)
})

test('地址末尾的斜杠会被削掉（拼路径时不会出现双斜杠）', () => {
  const id = plant(completeManifest({ default_base_url: 'http://127.0.0.1:9999///' }))
  assert.equal(resolveEngineProfile(id, {}).base_url, 'http://127.0.0.1:9999')
})

test('参考音频区间写 [3,10] 时解析成 {min,max}', () => {
  const id = plant(completeManifest({ capabilities: { reference_clip_seconds: [3, 10] } }))
  assert.deepStrictEqual(resolveEngineProfile(id, {}).reference_clip_seconds, { min: 3, max: 10 })
})

test('reference_clip_seconds=null 表示不限制，与「忘了写」不是一回事', () => {
  const ok = plant(completeManifest())                     // 显式写了 null
  assert.equal(resolveEngineProfile(ok, {}).reference_clip_seconds, null)

  const missing = plant(completeManifest(), (m) => { delete m.capabilities.reference_clip_seconds })
  assert.throws(() => resolveEngineProfile(missing, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INCOMPLETE' && /不限制请显式写 null/.test(e.message))
})

// ---------------------------------------------------------------------------
//  环境变量覆盖 —— 由名片指定变量名，平台不认识任何具体变量名
// ---------------------------------------------------------------------------

test('名片声明了 base_url_env，且该变量有值 ⇒ 用环境变量，并标明来源', () => {
  const id = plant(completeManifest({ base_url_env: 'MY_ENGINE_URL' }))
  const p = resolveEngineProfile(id, { MY_ENGINE_URL: 'http://10.0.0.5:1234/' })
  assert.equal(p.base_url, 'http://10.0.0.5:1234')
  assert.equal(p.base_url_source, 'env:MY_ENGINE_URL', '来源要能看出是被环境变量顶掉的')
})

test('声明了 base_url_env 但变量没设 ⇒ 回落名片里的地址（这不是「猜」，是名片写着的）', () => {
  const id = plant(completeManifest({ base_url_env: 'MY_ENGINE_URL' }))
  assert.equal(resolveEngineProfile(id, {}).base_url, 'http://127.0.0.1:9999')
})

test('没声明 base_url_env ⇒ 环境里就算有同名变量也不看', () => {
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, { MY_ENGINE_URL: 'http://10.0.0.5:1234' })
  assert.equal(p.base_url, 'http://127.0.0.1:9999')
})

// ---------------------------------------------------------------------------
//  缺字段就报错，不回落（Owner 2026-08-23 选 A）
// ---------------------------------------------------------------------------

for (const [keyPath, kill] of [
  ['default_base_url', (m) => { delete m.default_base_url }],
  ['timeout_ms', (m) => { delete m.timeout_ms }],
  ['max_chars', (m) => { delete m.max_chars }],
  ['capabilities.hot_swap_models', (m) => { delete m.capabilities.hot_swap_models }],
  ['capabilities.requires_reference_audio', (m) => { delete m.capabilities.requires_reference_audio }],
  ['capabilities.output_sample_rate', (m) => { delete m.capabilities.output_sample_rate }],
]) {
  test(`缺 ${keyPath} ⇒ 抛 ENGINE_MANIFEST_INCOMPLETE，且报错里点名这个键`, () => {
    const id = plant(completeManifest(), kill)
    assert.throws(() => resolveEngineProfile(id, {}), (e) => {
      assert.equal(e.code, 'ENGINE_MANIFEST_INCOMPLETE')
      assert.ok(e.message.includes(keyPath.split('.').pop()),
        `报错要说清缺的是哪个键，现在说的是：${e.message}`)
      return true
    })
  })
}

test('缺字段的报错里要带上名片路径 —— 让人知道去哪儿补', () => {
  const id = plant(completeManifest(), (m) => { delete m.timeout_ms })
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.message.includes('manifest.json') && e.missing === 'timeout_ms')
})

test('值写得不对（不是漏写）⇒ 抛 INVALID_VALUE，和「漏写」区分开', () => {
  for (const [over, key] of [
    [{ timeout_ms: 0 }, 'timeout_ms'],
    [{ timeout_ms: -1 }, 'timeout_ms'],
    [{ timeout_ms: '五分钟' }, 'timeout_ms'],
    [{ max_chars: 1.5 }, 'max_chars'],
    [{ capabilities: { output_sample_rate: 0 } }, 'capabilities.output_sample_rate'],
    [{ capabilities: { hot_swap_models: 'true' } }, 'capabilities.hot_swap_models'],
    [{ capabilities: { reference_clip_seconds: [10, 3] } }, 'capabilities.reference_clip_seconds'],
    [{ capabilities: { reference_clip_seconds: [3] } }, 'capabilities.reference_clip_seconds'],
    [{ capabilities: { reference_clip_seconds: 10 } }, 'capabilities.reference_clip_seconds'],
  ]) {
    const id = plant(completeManifest(over))
    assert.throws(() => resolveEngineProfile(id, {}),
      (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && e.key === key,
      `${key} = ${JSON.stringify(over)} 应该被判为「值不对」`)
  }
})

test('⚠ 布尔位写成字符串 "true" 会被拦下 —— JSON 里这是最常见的手滑', () => {
  const id = plant(completeManifest({ capabilities: { requires_reference_audio: 'true' } }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE')
})

test('没装这个引擎 ⇒ 沿用注册表的 FG_ENGINE_UNSUPPORTED，错误码对外不变', () => {
  assert.throws(() => resolveEngineProfile('nobody-home', {}),
    (e) => e.code === 'FG_ENGINE_UNSUPPORTED')
})

// ---------------------------------------------------------------------------
//  supports_finetune —— 契约 v2 明文规定「没写 = false」
// ---------------------------------------------------------------------------

test('supports_finetune 没写 ⇒ false（这是契约写着的默认，不算猜）', () => {
  const id = plant(completeManifest(), (m) => { delete m.capabilities.supports_finetune })
  assert.equal(resolveEngineProfile(id, {}).supports_finetune, false)
})

test('supports_finetune 只有写成 true 才是 true，"true" 不算', () => {
  const yes = plant(completeManifest({ capabilities: { supports_finetune: true } }))
  assert.equal(resolveEngineProfile(yes, {}).supports_finetune, true)
  const str = plant(completeManifest({ capabilities: { supports_finetune: 'true' } }))
  assert.equal(resolveEngineProfile(str, {}).supports_finetune, false)
})

// ---------------------------------------------------------------------------
//  守卫：lib/ 里不许出现具体引擎的名字
// ---------------------------------------------------------------------------
// 和 registry.node.test.js 里那条同源。第一次为了图快写下 if (id === 'gpt-sovits')
// 的时候，没有人觉得有问题；等到发现的时候，它已经被抄到了五个地方。
test('守卫：profile.js 里不许出现任何具体引擎的名字', () => {
  const src = fs.readFileSync(path.join(__dirname, 'profile.js'), 'utf8')
  // 注释块里作为「搬家前写死在哪」的历史说明提到引擎名是允许的，
  // 所以只检查去掉注释后的代码本体。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const name of ['gpt-sovits', 'gpt_sovits', 'sovits', 'indextts', 'GPT_SOVITS']) {
    assert.ok(!code.toLowerCase().includes(name.toLowerCase()),
      `profile.js 的代码里出现了引擎名 "${name}" —— 引擎的特殊性属于它自己的名片，不属于平台`)
  }
})
