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
      // ⛔ 这里原本有 hot_swap_models —— 2026-08-30 退休。夹具也一并删掉：
      //   夹具留着它，就等于让每一条测试都在替一个已死的字段作证。
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

test('名片写全时，该读的都读得出来', () => {
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, {})
  assert.equal(p.base_url, 'http://127.0.0.1:9999')
  assert.equal(p.base_url_source, 'manifest')
  assert.equal(p.timeout_ms, 300000)
  assert.equal(p.max_chars, 30)
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

test('⭐⭐ 刀 A3: 名片没写 default_base_url ⇒ 解析返回 base_url:null，⛔ 不许抛', () => {
  // 这是 A3 的判据：缺 default_base_url 是合法形态，由平台在 buildLaunchPlan({port})
  // 那一步决定「连」地址，不是解析这一步猜。解析若抛错，等于 A3 没做成。
  const id = plant(completeManifest(), (m) => { delete m.default_base_url })
  const p = resolveEngineProfile(id, {})
  assert.equal(p.base_url, null,
    '缺 default_base_url 时 base_url 应为 null（平台后续分配），不是静默猜一个地址')
  assert.equal(p.declared_base_url, null, 'declared_base_url 也要跟着是 null')
})

// ---------------------------------------------------------------------------
//  缺字段就报错，不回落（Owner 2026-08-23 选 A）
// ---------------------------------------------------------------------------

for (const [keyPath, kill] of [
  // ⭐ 刀 A3（2026-09-01）：default_base_url 从必填表里移出——契约 §5.9
  //   明确「端口是运输不是管理」，平台负责给由它启动的引擎分配端口，
  //   名片作者不该写下「我该监听 9880」。缺 default_base_url 现在是合法形态，
  //   见下面新增的断言（解析返回 base_url:null 而不抛）。
  ['timeout_ms', (m) => { delete m.timeout_ms }],
  ['max_chars', (m) => { delete m.max_chars }],
  // ⛔ capabilities.hot_swap_models 曾经在这张必填清单里 —— 2026-08-30 退休，
  //   ⇒ 删掉它不再是"缺字段"，见下面「退休」那一节。
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
    // ⛔ hot_swap_models 曾经在这里 —— 退休之后连"值写错"都不再是错，
    //   见下面「退休」那一节里那条「写成什么样都照装」。
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
//  models：底模从哪来（2026-08-29）
// ---------------------------------------------------------------------------
// ⚠ 这一段只测「名片上声明的那部分」。盘上到底有没有是 checkpoints.js 的活，
//   在 checkpoints.node.test.js 里测 —— 计划/执行分家，测试也跟着分。

test('不写 models 段是合法的：models === null，⛔ 不等于「底模缺失」', () => {
  const id = plant(completeManifest())
  assert.strictEqual(resolveEngineProfile(id, {}).models, null)
})

test('models 写全时四个字段都读得出来，cwd 不写默认 engine_dir', () => {
  const id = plant(completeManifest({
    models: {
      checkpoints_env: 'DEMO_CKPT_DIR',
      required: ['config.yaml', 'sub/w.pth'],
      hint: '自己下',
      source: {
        url: 'https://example.invalid/m',
        license_gate: true,
        command: ['dl', '--out', '{checkpoints}'],
      },
    },
  }))
  const m = resolveEngineProfile(id, {}).models
  assert.strictEqual(m.checkpoints_env, 'DEMO_CKPT_DIR')
  assert.deepStrictEqual(m.required, ['config.yaml', 'sub/w.pth'])
  assert.strictEqual(m.hint, '自己下')
  assert.strictEqual(m.source.license_gate, true)
  assert.strictEqual(m.source.cwd, 'engine_dir')
})

test('license_gate 不写 = false（"要不要点同意"必须是明确的假，不是 undefined）', () => {
  const id = plant(completeManifest({
    models: { source: { url: 'https://example.invalid/m' } },
  }))
  assert.strictEqual(resolveEngineProfile(id, {}).models.source.license_gate, false)
})

test('models 里拼错的键当场抛 —— 静默忽略的表现是「体检永远说底模齐」', () => {
  const id = plant(completeManifest({ models: { requried: ['a'] } }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /requried/.test(e.message))
})

test('models.source 里拼错的键也当场抛', () => {
  const id = plant(completeManifest({ models: { source: { urls: 'x' } } }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /urls/.test(e.message))
})

test('command 必须是 argv 数组：写成一整行字符串要抛', () => {
  // ⛔ 一整行的问题不是不好看：路径里有空格时会被拆错，
  //   而拆错之后命令照样"跑得动"，只是下到别的地方去了。
  const id = plant(completeManifest({
    models: { source: { command: 'dl --out {checkpoints}' } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /argv/.test(e.message))
})

test('command 里不认识的占位符要抛（否则会下到一个叫 {checkpoint} 的目录里）', () => {
  const id = plant(completeManifest({
    models: { source: { command: ['dl', '--out', '{checkpoint}'] } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /\{checkpoint\}/.test(e.message))
})

test('command 里没有 {checkpoints} 要抛 —— 下完了平台照样说没放', () => {
  const id = plant(completeManifest({
    models: { source: { command: ['dl', '--out', './somewhere'] } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /\{checkpoints\}/.test(e.message))
})

test('models.required 里写绝对路径要抛（每一项都是相对底模目录的）', () => {
  for (const bad of ['/opt/models/a.pth', 'D:\\models\\a.pth']) {
    const id = plant(completeManifest({ models: { required: [bad] } }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /绝对路径/.test(e.message),
      `${bad} 应该被拒`)
  }
})

test('models.source.cwd 只认两个值', () => {
  const ok = plant(completeManifest({
    models: { source: { command: ['dl', '{checkpoints}'], cwd: 'root' } },
  }))
  assert.strictEqual(resolveEngineProfile(ok, {}).models.source.cwd, 'root')

  const bad = plant(completeManifest({
    models: { source: { command: ['dl', '{checkpoints}'], cwd: 'checkpoints' } },
  }))
  assert.throws(() => resolveEngineProfile(bad, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INVALID_VALUE')
})

test('models 只写 hint、一个 source 都没有，也是合法的（有些模型就得手动放）', () => {
  const id = plant(completeManifest({ models: { hint: '去官网下' } }))
  const m = resolveEngineProfile(id, {}).models
  assert.strictEqual(m.hint, '去官网下')
  assert.strictEqual(m.source, null)
  assert.deepStrictEqual(m.required, [])
})

// ---------------------------------------------------------------------------
//  守卫：lib/ 里不许出现具体引擎的名字
// ---------------------------------------------------------------------------
// 和 registry.node.test.js 里那条同源。第一次为了图快写下 if (id === 'gpt-sovits')
// 的时候，没有人觉得有问题；等到发现的时候，它已经被抄到了五个地方。
// ---------------------------------------------------------------------------
//  换一份权重，送到哪一步（weights[].applies_at）
//
//  ⭐ 只有两个值，而且穷尽：
//     launch = 开进程那一步吃进去的（换一份 = 带着它重开一次）
//     call   = 进程活着时一次调用就能换（必须配 param）
//  ⭐⭐ 引擎级那个 hot_swap_models 已经**退休**：「能不能换」是每个位各自的
//     事，一台引擎两个位一个能换一个不能的时候，那一位没有正确答案。
// ---------------------------------------------------------------------------

test('不写 applies_at ⇒ 按有没有 param 推', () => {
  const hot = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model' }],
  }))
  assert.equal(resolveEngineProfile(hot, {}).weight_slots[0].applies_at, 'call')

  const cold = plant(completeManifest({ weights: [{ name: 'a' }] }))
  const p = resolveEngineProfile(cold, {})
  assert.equal(p.weight_slots[0].applies_at, 'launch')
})

test('⭐ 一个位一次调用能换、一个位要重开进程 —— 逐位说话，⛔ 不合并成一个是非题', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model' }, { name: 'b' }],
  }))
  const p = resolveEngineProfile(id, {})
  assert.deepEqual(p.weight_slots.map((s) => s.applies_at), ['call', 'launch'])
})

test('⛔ 说自己一次调用能换、却没说走哪个参数名 ⇒ 装不上', () => {
  const id = plant(completeManifest({
    weights: [{ name: 'a', applies_at: 'call' }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INCOMPLETE')
    return true
  })
})

test('⛔ 说自己是开进程时吃进去的、又写了参数名 ⇒ 装不上（那个键永远发不出去）', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model', applies_at: 'launch' }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /param/)
    return true
  })
})

test('⛔ applies_at 只有两个值，第三个当场拒绝', () => {
  const id = plant(completeManifest({ weights: [{ name: 'a', applies_at: 'per_request' }] }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /applies_at/)
    return true
  })
})

// ---------------------------------------------------------------------------
//  退休：capabilities.hot_swap_models（2026-08-30）
//
//  ⭐⭐⭐ 硬约束是「不麻烦上游作者」⇒ 老名片还写着它，必须**照装**。
//     ⛔ 但也不许静默：平台每台引擎提醒一次，告诉作者这一行可以删了。
//  ⚠ 下面三条一起钉住这个退休的三个面：不再必填 / 写错也不拦 / 不再产出。
// ---------------------------------------------------------------------------

test('⭐ 退休后：整行不写照样装得上（新名片不用再回答这个问题）', () => {
  const id = plant(completeManifest())   // 夹具里本来就没有它了
  const p = resolveEngineProfile(id, {})
  assert.equal(p.base_url, 'http://127.0.0.1:9999')
})

test('⭐⭐ 退休后：老名片还写着它 —— 写 true / false / 甚至写错值，都照装不拦', () => {
  // ⭐ 「写错值也不拦」是有意的：一个平台**不再读**的字段，拿它拦下一整台
  //   装得好好的引擎，是纯粹的自伤。⛔ 别因为"顺手能校验"就去校验死字段。
  for (const v of [true, false, 'true', 0, null]) {
    const id = plant(completeManifest({ capabilities: { hot_swap_models: v } }))
    const p = resolveEngineProfile(id, {})
    assert.equal(p.max_chars, 30, `hot_swap_models=${JSON.stringify(v)} 不该拦下这张名片`)
  }
})

test('⛔⛔ 退休后：引擎档案里不许再有 hot_swap_models 这个属性', () => {
  // ⭐ 这条是防「退而不休」：属性还在，就一定会有人接着读它，
  //   而它现在的值只可能是一台两种位都有的引擎的**错误答案**。
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model' }, { name: 'b' }],
    capabilities: { hot_swap_models: true },
  }))
  const p = resolveEngineProfile(id, {})
  assert.ok(!('hot_swap_models' in p),
    '引擎档案里还有 hot_swap_models —— 退休没退干净，下游会继续读到一个错答案')
})

test('⛔⛔ 退休后：lib/ 和 web/ 里不许再有任何一处**读** hot_swap_models', () => {
  // ⭐⭐⭐ 源码守卫。上一轮的教训：一个字段"逻辑上退休"了，但某个消费者还在
  //   读，于是它悄悄回到了决策路径上，而所有测试都是绿的。
  // ⚠ 只禁**读**（`.hot_swap_models` / `['hot_swap_models']`），不禁提到这个
  //   名字：注释、报错文案、名片里的说明都必须能继续写，否则作者看不懂为什么
  //   自己那一行不生效了。
  const roots = [
    path.join(__dirname, '..'),                       // lib/
    path.join(__dirname, '..', '..', 'web', 'src'),   // web/src/
  ]
  const bad = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        walk(full); continue
      }
      if (!/\.(js|jsx|cjs|mjs)$/.test(e.name)) continue
      if (/\.node\.test\./.test(e.name)) continue        // 测试自己不算消费者
      const src = fs.readFileSync(full, 'utf8')
      for (const line of src.split('\n')) {
        // ⭐ 唯一的豁免口：退休函数自己必须能看这个键一眼，才能提醒作者删掉它。
        //   ⚠ 豁免要写成一个**得手动打上去的标记**，⛔ 不许按文件名整份放行 ——
        //   放行整个 profile.js，等于把最可能偷偷读回去的那个文件排除在外。
        if (line.includes('retired-reader-ok')) continue
        const code = line.replace(/\/\/.*$/, '')         // 掐掉行尾注释
        if (/^\s*[*/]/.test(line)) continue              // 整行是块注释
        if (/\.hot_swap_models\b|\['hot_swap_models'\]|\["hot_swap_models"\]/.test(code)) {
          bad.push(`${path.relative(roots[0], full)}: ${line.trim()}`)
        }
      }
    }
  }
  for (const r of roots) { if (fs.existsSync(r)) walk(r) }
  assert.deepEqual(bad, [],
    '这些地方还在读一个已经退休的字段：\n' + bad.join('\n'))
})

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
