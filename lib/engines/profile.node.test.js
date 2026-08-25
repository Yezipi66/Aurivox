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
//  runtime —— 进程与环境的宿主（2026-08-24 接上电）
// ---------------------------------------------------------------------------
// 这一段在契约里写了很久，但在 envCheck.js 之前**没有任何人读它**。死数据
// 不会报错，它只会在你终于用上它的那天报错 —— 真名片里那个把 `.venv` 写成
// `venv` 的路径就是这么活下来的。下面这些守卫是它的读者。

const RUNTIME = Object.freeze({
  python: 'venv/bin/python',
  entry: 'shim.py',
  ready_endpoint: '/health',
  ready_timeout_ms: 180000,
  preload: true,
})

test('runtime：写全了就逐字读出来', () => {
  const id = plant(completeManifest({ runtime: Object.assign({}, RUNTIME) }))
  const rt = resolveEngineProfile(id, {}).runtime
  assert.equal(rt.python, 'venv/bin/python')
  assert.equal(rt.entry, 'shim.py')
  assert.equal(rt.ready_endpoint, '/health')
  assert.equal(rt.ready_timeout_ms, 180000)
  assert.equal(rt.preload, true)
  assert.equal(rt.verify, null)
})

test('⭐ runtime：整段缺失是合法的，得到 null（含义：这台引擎不由平台起）', () => {
  const id = plant(completeManifest())
  assert.equal(resolveEngineProfile(id, {}).runtime, null)
  // ⛔ 别改成 {}：空对象和"写了但字段都缺"长得一样，而后者必须抛。
})

for (const key of ['python', 'entry', 'ready_endpoint', 'ready_timeout_ms']) {
  test(`runtime：写了这一段就不许缺 ${key}（缺字段不回落，见文件头的理由）`, () => {
    const rt = Object.assign({}, RUNTIME)
    delete rt[key]
    const id = plant(completeManifest({ runtime: rt }))
    assert.throws(() => resolveEngineProfile(id, {}), (err) => {
      assert.equal(err.code, 'ENGINE_MANIFEST_INCOMPLETE')
      assert.match(err.message, new RegExp(key))
      return true
    })
  })
}

test('⛔ runtime：平台不认识的键要当场抛（拼错被静默吃掉 = 轮询永远超时）', () => {
  const id = plant(completeManifest({
    runtime: Object.assign({}, RUNTIME, { ready_endoint: '/health' }),  // 少一个 p
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (err) => {
    assert.equal(err.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(err.message, /ready_endoint/)
    return true
  })
})

test('⛔ runtime：路径不许写绝对路径（名片要跟着项目搬家）', () => {
  for (const bad of ['/opt/x/python', 'C:\\Python\\python.exe', 'D:/venv/python.exe']) {
    const id = plant(completeManifest({ runtime: Object.assign({}, RUNTIME, { python: bad }) }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE',
      `绝对路径 ${bad} 竟然被放过了`)
  }
})

test('runtime：entry 用 ../.. 走出引擎目录是允许的（GSV 的入口在平台 lib 下）', () => {
  const id = plant(completeManifest({
    runtime: Object.assign({}, RUNTIME, { entry: '../../lib/inference/infer_server.py' }),
  }))
  assert.equal(resolveEngineProfile(id, {}).runtime.entry, '../../lib/inference/infer_server.py')
})

test('runtime：ready_endpoint 必须以 / 开头', () => {
  const id = plant(completeManifest({ runtime: Object.assign({}, RUNTIME, { ready_endpoint: 'health' }) }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE')
})

test('runtime：ready_timeout_ms 必须是正整数', () => {
  for (const bad of [0, -1, 1.5, '一分钟']) {
    const id = plant(completeManifest({ runtime: Object.assign({}, RUNTIME, { ready_timeout_ms: bad }) }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE', `${bad} 被当成合法超时了`)
  }
})

test('runtime：preload 缺省为 false（这个位只在显式写 true 时才是 true）', () => {
  const rt = Object.assign({}, RUNTIME)
  delete rt.preload
  const id = plant(completeManifest({ runtime: rt }))
  assert.equal(resolveEngineProfile(id, {}).runtime.preload, false)
})

test('runtime.verify：读得出 sys_path / module / class / methods / init_params', () => {
  const id = plant(completeManifest({
    runtime: Object.assign({}, RUNTIME, {
      verify: {
        sys_path: ['engines/demo/pkg'],
        imports: [{ module: 'a.b', class: 'C', methods: ['m'], init_params: ['p'] }],
      },
    }),
  }))
  const v = resolveEngineProfile(id, {}).runtime.verify
  assert.deepEqual(v.sys_path, ['engines/demo/pkg'])
  assert.equal(v.imports.length, 1)
  assert.deepEqual(v.imports[0], { module: 'a.b', class: 'C', methods: ['m'], init_params: ['p'] })
})

test('⛔ runtime.verify：写了 verify 却没有 imports 要抛（一条都不查 = 没有校验）', () => {
  for (const bad of [{ sys_path: [] }, { imports: [] }]) {
    const id = plant(completeManifest({ runtime: Object.assign({}, RUNTIME, { verify: bad }) }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE',
      `空 verify ${JSON.stringify(bad)} 被放过了 —— 它会显示成"校验通过"`)
  }
})

test('⛔ runtime.verify：写了 methods/init_params 却没写 class 要抛（它们挂在类上）', () => {
  for (const bad of [{ module: 'a', methods: ['m'] }, { module: 'a', init_params: ['p'] }]) {
    const id = plant(completeManifest({
      runtime: Object.assign({}, RUNTIME, { verify: { imports: [bad] } }),
    }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE',
      `${JSON.stringify(bad)} 被放过了 —— "我写了要检查 infer" 会变成一句空话`)
  }
})

test('⛔ runtime.verify.imports 上不认识的键也要抛', () => {
  const id = plant(completeManifest({
    runtime: Object.assign({}, RUNTIME, {
      verify: { imports: [{ module: 'a', class: 'C', method: ['m'] }] },  // method 少个 s
    }),
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (err) => {
    assert.match(err.message, /method/)
    return err.code === 'ENGINE_MANIFEST_INVALID_VALUE'
  })
})

test('runtime.verify：只写 module（不写 class）是合法的 —— 只查"这个包在不在"', () => {
  const id = plant(completeManifest({
    runtime: Object.assign({}, RUNTIME, { verify: { imports: [{ module: 'a' }] } }),
  }))
  const v = resolveEngineProfile(id, {}).runtime.verify
  assert.equal(v.imports[0].class, null)
  assert.deepEqual(v.imports[0].methods, [])
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
