'use strict'

//  lib/engines/profile.js：名片解析
// 这些测试用的是临时目录里造的假名片，不碰仓库里真的 engines/。
// 原因：真名片会随业务变（有一天 max_chars 从 30 调到 25 是完全合理的），
// 那时候不该有一堆测试跟着红。真名片的正确性由本文件最后一段
// 「真名片体检」负责，那部分只判「读得出来、不抛」，不锁具体数值。
//
// ENGINES_DIR 必须在 require 之前设好：lib/paths.js 在模块加载时就
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
    timeout_ms_source: 'measured',
    max_chars: 30,
    max_chars_source: 'measured',
    param_keys: ['format', 'split'],
    capabilities: Object.assign({
      // 这里原本有 hot_swap_models： 退休。夹具也一并删掉：
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

//  读得出来

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

test('reference_clip_seconds：写 null 与不写都是不限制；不写时记进 defaulted', () => {
  const ok = plant(completeManifest())                     // 显式写了 null
  const p1 = resolveEngineProfile(ok, {})
  assert.equal(p1.reference_clip_seconds, null)
  assert.ok(!p1.defaulted.includes('capabilities.reference_clip_seconds'), '显式写了就不算平台默认')

  const missing = plant(completeManifest(), (m) => { delete m.capabilities.reference_clip_seconds })
  const p2 = resolveEngineProfile(missing, {})
  assert.equal(p2.reference_clip_seconds, null)
  assert.ok(p2.defaulted.includes('capabilities.reference_clip_seconds'), '平台替名片答的要如实报出去')
})

//  环境变量覆盖：由名片指定变量名，平台不认识任何具体变量名

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
  // 缺 default_base_url 是合法形态：「连」地址由平台在 buildLaunchPlan({port}) 那一步
  // 决定，解析这一步不猜、也不抛。
  const id = plant(completeManifest(), (m) => { delete m.default_base_url })
  const p = resolveEngineProfile(id, {})
  assert.equal(p.base_url, null,
    '缺 default_base_url 时 base_url 应为 null（平台后续分配），不是静默猜一个地址')
  assert.equal(p.declared_base_url, null, 'declared_base_url 也要跟着是 null')
})

//  只有 5 项必须人答（call.bind 三槽位 + runtime.python / entry）；
//  其余缺了走平台默认或推断，并记进 profile.defaulted，界面据此标「平台默认」。

const { DEFAULTS } = require('./profile')

for (const [keyPath, kill, expect] of [
  ['timeout_ms', (m) => { delete m.timeout_ms; delete m.timeout_ms_source }, (p) => p.timeout_ms === DEFAULTS.timeout_ms],
  ['max_chars', (m) => { delete m.max_chars; delete m.max_chars_source }, (p) => p.max_chars === DEFAULTS.max_chars && p.hard_max_chars === DEFAULTS.max_chars * 2],
]) {
  test(`缺 ${keyPath} ⇒ 不抛，走平台默认并记进 defaulted`, () => {
    const id = plant(completeManifest(), kill)
    const p = resolveEngineProfile(id, {})
    assert.ok(expect(p), `${keyPath} 的默认值不对`)
    assert.ok(p.defaulted.includes(keyPath), `${keyPath} 没记进 defaulted`)
  })
}

test('缺 output_sample_rate ⇒ null 且不算平台默认（它只是声明，平台不读）', () => {
  const id = plant(completeManifest(), (m) => { delete m.capabilities.output_sample_rate })
  const p = resolveEngineProfile(id, {})
  assert.strictEqual(p.output_sample_rate, null)
  assert.ok(!p.defaulted.includes('capabilities.output_sample_rate'), '平台没有替它定任何值，不该标「平台默认」')
})

test('写全了 ⇒ defaulted 是空的（名片写的不许被当成平台默认）', () => {
  const id = plant(completeManifest())
  assert.deepStrictEqual(resolveEngineProfile(id, {}).defaulted, [])
})

test('缺 requires_reference_audio ⇒ 看 call.bind 绑没绑参考音频槽位', () => {
  const bound = plant(completeManifest({ call: { kind: 'python', module: 'm', class: 'C', method: 'f',
    bind: { text: 'text', ref_audio: 'prompt_wav', output_path: 'out' } } }),
  (m) => { delete m.capabilities.requires_reference_audio })
  const p = resolveEngineProfile(bound, {})
  assert.equal(p.requires_reference_audio, true, '绑了参考音频槽位就该要求参考音频')
  assert.ok(p.defaulted.includes('capabilities.requires_reference_audio'))

  const unbound = plant(completeManifest(), (m) => { delete m.capabilities.requires_reference_audio })
  assert.equal(resolveEngineProfile(unbound, {}).requires_reference_audio, false)

  // 写了 false 就是 false，绑定推不翻表态。
  const said = plant(completeManifest({ capabilities: { requires_reference_audio: false },
    call: { kind: 'python', module: 'm', class: 'C', method: 'f', bind: { text: 'text', ref_audio: 'prompt_wav' } } }))
  assert.equal(resolveEngineProfile(said, {}).requires_reference_audio, false)
})

test('5 项之一缺了照样抛，报错里带上名片路径', () => {
  const id = plant(completeManifest({ runtime: { entry: 'shim.py', ready_endpoint: '/health' } }))
  assert.throws(() => resolveEngineProfile(id, {}),
    (e) => e.code === 'ENGINE_MANIFEST_INCOMPLETE' && e.message.includes('manifest.json') && e.missing === 'runtime.python')
})

test('值写得不对（不是漏写）⇒ 抛 INVALID_VALUE，和「漏写」区分开', () => {
  for (const [over, key] of [
    [{ timeout_ms: 0 }, 'timeout_ms'],
    [{ timeout_ms: -1 }, 'timeout_ms'],
    [{ timeout_ms: '五分钟' }, 'timeout_ms'],
    [{ max_chars: 1.5 }, 'max_chars'],
    [{ capabilities: { output_sample_rate: 0 } }, 'capabilities.output_sample_rate'],
    // hot_swap_models 不在这里：退休之后连"值写错"都不再是错，
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

//  supports_finetune：契约 v2 明文规定「没写 = false」

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

// runtime：进程与环境的宿主（接上电）
// 这一段在契约里写了很久，但在 envCheck.js 之前没有任何人读它。死数据
// 不会报错，它只会在你终于用上它的那天报错：真名片里那个把 `.venv` 写成
// `venv` 的路径就是这么活下来的。下面这些守卫是它的读者。

const RUNTIME = Object.freeze({
  python: 'venv/bin/python',
  entry: 'shim.py',
  ready_endpoint: '/health',
  ready_timeout_ms: 180000,
  ready_timeout_ms_source: 'measured',
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
  // 别改成 {}：空对象和"写了但字段都缺"长得一样，而后者必须抛。
})

for (const key of ['python', 'entry', 'ready_endpoint']) {
  test(`runtime：写了这一段就不许缺 ${key}（启动脚本不是通用宿主时，就绪端点也得写）`, () => {
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

test('runtime：启动脚本是通用宿主 ⇒ 就绪端点缺省 /health；就绪等待缺省走平台默认', () => {
  const rt = { python: 'engines/x/.venv', entry: '../../lib/engines/host.py' }
  const id = plant(completeManifest({ runtime: rt }))
  const p = resolveEngineProfile(id, {})
  assert.equal(p.runtime.ready_endpoint, '/health')
  assert.equal(p.runtime.ready_timeout_ms, DEFAULTS.ready_timeout_ms)
  assert.ok(p.defaulted.includes('runtime.ready_endpoint'))
  assert.ok(p.defaulted.includes('runtime.ready_timeout_ms'))
})

test('runtime：启动脚本是通用宿主且没写 args ⇒ 缺省 --profile-json/--host/--port（否则宿主以 code=2 退出）', () => {
  const rt = { python: 'engines/x/.venv', entry: '../../lib/engines/host.py' }
  const p = resolveEngineProfile(plant(completeManifest({ runtime: rt })), {})
  assert.deepEqual(p.runtime.args, ['--profile-json', '{profile_json}', '--host', '{host}', '--port', '{port}'])
  assert.ok(p.defaulted.includes('runtime.args'))
  // 写了就照名片（哪怕是空数组：那是作者的明确答案）
  const p2 = resolveEngineProfile(plant(completeManifest({ runtime: { ...rt, args: [] } })), {})
  assert.deepEqual(p2.runtime.args, [])
  assert.ok(!p2.defaulted.includes('runtime.args'))
  // 不是通用宿主 ⇒ 平台答不出，缺了就是不带参数（旧行为）
  const p3 = resolveEngineProfile(plant(completeManifest({ runtime: { ...rt, entry: 'serve.py', ready_endpoint: '/health' } })), {})
  assert.deepEqual(p3.runtime.args, [])
  assert.ok(!p3.defaulted.includes('runtime.args'))
})

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

// models：底模从哪来
// 这一段只测「名片上声明的那部分」。盘上到底有没有是 checkpoints.js 的活，
//   在 checkpoints.node.test.js 里测：计划/执行分家，测试也跟着分。

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
  // 一整行的问题不是不好看：路径里有空格时会被拆错，
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

//  守卫：lib/ 里不许出现具体引擎的名字
// 和 registry.node.test.js 里那条同源。第一次为了图快写下 if (id === 'gpt-sovits')
// 的时候，没有人觉得有问题；等到发现的时候，它已经被抄到了五个地方。
//  换一份权重，送到哪一步（weights[].applies_at）
//
// 只有两个值，而且穷尽：
//     launch = 开进程那一步吃进去的（换一份 = 带着它重开一次）
//     call   = 进程活着时一次调用就能换（必须配 param）
// 引擎级那个 hot_swap_models 已经退休：「能不能换」是每个位各自的
//     事，一台引擎两个位一个能换一个不能的时候，那一位没有正确答案。

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

//  weights[].switch：换这一份时平台额外发那个请求

test('⭐ switch 原样进 weight_slots（endpoint / query 一个不改）', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{
      name: 'a', param: 'a_model', applies_at: 'call',
      switch: { endpoint: '/set_weights', query: 'path' },
    }],
  }))
  const slot = resolveEngineProfile(id, {}).weight_slots[0]
  assert.deepEqual(slot.switch, { endpoint: '/set_weights', query: 'path' })
})

test('📌 名片没写 switch ⇒ weight_slots 里不长这个键（老名片的规整结果逐字不变）', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model', applies_at: 'call' }],
  }))
  assert.equal(resolveEngineProfile(id, {}).weight_slots[0].switch, undefined)
})

test('📌 switch: null 与没写一样：不保留这个键，也不当成半个对象收下', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model', applies_at: 'call', switch: null }],
  }))
  assert.equal(resolveEngineProfile(id, {}).weight_slots[0].switch, undefined)
})

test('⛔ switch 只能写在 call 位：launch 位写了当场拒绝', () => {
  const id = plant(completeManifest({
    weights: [{
      name: 'a', applies_at: 'launch',
      switch: { endpoint: '/set_weights', query: 'path' },
    }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /switch/)
    return true
  })
})

test('⛔ switch.endpoint 必须以 / 开头', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{
      name: 'a', param: 'a_model',
      switch: { endpoint: 'set_weights', query: 'path' },
    }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), /switch\.endpoint/)
})

test('⛔ switch 少了 query（选中的值无处可放）当场拒绝', () => {
  const id = plant(completeManifest({
    param_keys: ['format', 'split', 'a_model'],
    weights: [{ name: 'a', param: 'a_model', switch: { endpoint: '/set_weights' } }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), /switch\.query/)
})

test('⛔ 写了 switch 却没有地址 ⇒ 当场拒绝（合成时才炸是通用 500）', () => {
  const id = plant(completeManifest({
    default_base_url: undefined,
    param_keys: ['format', 'split', 'a_model'],
    weights: [{
      name: 'a', param: 'a_model', applies_at: 'call',
      switch: { endpoint: '/set_weights', query: 'path' },
    }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INCOMPLETE')
    assert.match(e.message, /default_base_url/)
    assert.match(e.message, /base_url_env/)
    return true
  })
})

test('⛔⛔ stdio 引擎写 switch 当场拒绝：平台不会发那个请求，静默忽略等于骗人', () => {
  const id = plant(completeManifest({
    default_base_url: undefined,
    param_keys: ['format', 'split', 'a_model'],
    runtime: { python: 'python', entry: 'lib/engines/host.py' },
    weights: [{
      name: 'a', param: 'a_model', applies_at: 'call',
      switch: { endpoint: '/set_weights', query: 'path' },
    }],
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /stdio/)
    return true
  })
})

test('stdio 引擎不写 switch ⇒ 照装，transport 仍是 stdio', () => {
  const id = plant(completeManifest({
    default_base_url: undefined,
    param_keys: ['format', 'split', 'a_model'],
    runtime: { python: 'python', entry: 'lib/engines/host.py' },
    weights: [{ name: 'a', param: 'a_model', applies_at: 'call' }],
  }))
  const p = resolveEngineProfile(id, {})
  assert.equal(p.transport, 'stdio')
  assert.equal(p.weight_slots[0].switch, undefined)
})

// 退休：capabilities.hot_swap_models
//
// 硬约束是「不麻烦上游作者」⇒ 老名片还写着它，必须照装。
// 但也不许静默：平台每台引擎提醒一次，告诉作者这一行可以删了。
// 下面三条一起钉住这个退休的三个面：不再必填 / 写错也不拦 / 不再产出。

test('⭐ 退休后：整行不写照样装得上（新名片不用再回答这个问题）', () => {
  const id = plant(completeManifest())   // 夹具里本来就没有它了
  const p = resolveEngineProfile(id, {})
  assert.equal(p.base_url, 'http://127.0.0.1:9999')
})

test('⭐⭐ 退休后：老名片还写着它 —— 写 true / false / 甚至写错值，都照装不拦', () => {
  // 「写错值也不拦」是有意的：一个平台不再读的字段，拿它拦下一整台
  // 装得好好的引擎，是纯粹的自伤。 别因为"顺手能校验"就去校验死字段。
  for (const v of [true, false, 'true', 0, null]) {
    const id = plant(completeManifest({ capabilities: { hot_swap_models: v } }))
    const p = resolveEngineProfile(id, {})
    assert.equal(p.max_chars, 30, `hot_swap_models=${JSON.stringify(v)} 不该拦下这张名片`)
  }
})

test('⛔⛔ 退休后：引擎档案里不许再有 hot_swap_models 这个属性', () => {
  // 这条是防「退而不休」：属性还在，就一定会有人接着读它，
  // 而它现在的值只可能是一台两种位都有的引擎的错误答案。
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
  // 源码守卫。上一轮的教训：一个字段"逻辑上退休"了，但某个消费者还在
  //   读，于是它悄悄回到了决策路径上，而所有测试都是绿的。
  // 只禁读（`.hot_swap_models` / `['hot_swap_models']`），不禁提到这个
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
        // 唯一的豁免口：退休函数自己必须能看这个键一眼，才能提醒作者删掉它。
        // 豁免要写成一个得手动打上去的标记， 不许按文件名整份放行
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

// 一次请求一个方法
//
// 宿主那侧 就接好了（hostProfile.js 的校验 + host.py 的
// resolve_method），但前端这条路：profile.js → routes/engines.js
//    → /api/engines：一个字都没交 ⇒ 界面上五种方法一个都选不到。
//    这一段补的就是那条路。
//
// 交出去的是名字列表，不是 call.methods 那个对象：界面只需要画一个
//    下拉 + 知道默认选哪个，方法内部怎么绑参数是宿主的事。

test('多方法：交出名字列表 + 默认那个（界面上就是这一个下拉）', () => {
  const id = plant(completeManifest({
    call: {
      methods: {
        quick: { method: 'infer_fast' },
        careful: { method: 'infer_slow' },
      },
      default_method: 'careful',
    },
  }))
  const p = resolveEngineProfile(id, {})
  assert.deepEqual(p.methods, ['quick', 'careful'])
  assert.equal(p.default_method, 'careful')
})

test('⭐ 单方法引擎：methods 是 null，不是 []（两者在界面上画出来不一样）', () => {
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, {})
  // null = 「这台引擎就一个推理入口」⇒ 界面画固定标签，不画下拉
  // []   = 「声明了但空的」⇒ 那在解析层就当场抛了，不该走到这里
  assert.equal(p.methods, null)
  assert.equal(p.default_method, null)
})

test('call.methods 写空对象 ⇒ 当场抛，不许安静地变成「没有方法」', () => {
  const id = plant(completeManifest({ call: { methods: {} , default_method: 'x' } }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /call\.methods 写了个空对象/)
    return true
  })
})

test('多方法但没写 default_method ⇒ 抛，且⛔不许「取第一个」', () => {
  const id = plant(completeManifest({
    call: { methods: { a: { method: 'x' }, b: { method: 'y' } } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /default_method/)
    // 「取第一个」会让默认随名片的编辑顺序漂移：错误文案要点破这件事
    assert.match(e.message, /不许「取第一个」/)
    return true
  })
})

test('default_method 不在 methods 里 ⇒ 抛，并列出现有的', () => {
  const id = plant(completeManifest({
    call: { methods: { a: { method: 'x' } }, default_method: 'nope' },
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /"nope"/)
    assert.match(e.message, /a/)       // 要告诉作者现有的是哪些
    return true
  })
})

test('call 段不是对象 ⇒ 抛（别让它安静地退化成单方法）', () => {
  const id = plant(completeManifest({ call: 'nope' }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /call 必须是一个对象/)
    return true
  })
})

//  maps.text：启动脚本是通用宿主时由平台推断

const SHARED_RUNTIME = { python: 'engines/x/.venv', entry: '../../lib/engines/host.py' }

test('通用宿主 + 名片没写 maps.text ⇒ 平台补成宿主收文本的键，并记进 defaulted', () => {
  const { SHARED_HOST_TEXT_KEY } = require('./profile')
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME, maps: { reference_text: 'ref_words' } }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.equal(p.maps.text, SHARED_HOST_TEXT_KEY)
  assert.equal(p.maps.reference_text, 'ref_words', '名片写了的其余项原样保留')
  assert.ok(p.defaulted.includes('maps.text'), '平台替名片答的要如实报出去')
})

test('通用宿主 + 连 maps 段都没有 ⇒ 照样补 maps.text，拼请求不再抛', () => {
  const { assembleEnginePayload } = require('./payload')
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  const payload = assembleEnginePayload({ profile: p, canonical: { text: '你好' } })
  assert.deepStrictEqual(payload, { [p.maps.text]: '你好' })
})

test('名片自己写了 maps.text ⇒ 用名片的，不算平台默认', () => {
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME, maps: { text: 'words' } }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.equal(p.maps.text, 'words')
  assert.ok(!p.defaulted.includes('maps.text'))
})

test('名片显式写 maps.text = null（没这个概念）⇒ 尊重名片，不补', () => {
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME, maps: { text: null } }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.equal(p.maps.text, undefined)
  assert.ok(!p.defaulted.includes('maps.text'))
})

test('启动脚本是引擎自带服务 ⇒ 平台答不出 maps.text，不补（拼请求照旧点名报缺）', () => {
  const { assembleEnginePayload } = require('./payload')
  const id = plant(completeManifest({
    runtime: { python: 'engines/x/.venv', entry: 'serve.py', ready_endpoint: '/ping' },
  }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.equal(p.maps.text, undefined)
  assert.throws(() => assembleEnginePayload({ profile: p, canonical: { text: '你好' } }),
    (e) => e.code === 'ENGINE_MANIFEST_INCOMPLETE' && e.missing === 'maps.text')
})

test('推断出来的键与宿主真读的键一致：host.py 的 /tts 从 body 里按这个键取文本', () => {
  const { SHARED_HOST_TEXT_KEY } = require('./profile')
  const src = fs.readFileSync(path.join(__dirname, 'host.py'), 'utf8')
  assert.ok(src.includes(`body.get("${SHARED_HOST_TEXT_KEY}")`),
    `host.py 不再从 body["${SHARED_HOST_TEXT_KEY}"] 取文本了：profile.js 的 SHARED_HOST_TEXT_KEY 要跟着改`)
})

//  参考音频 / 参考文本：启动脚本是通用宿主时同样由平台推断

test('通用宿主 + 名片没写 maps ⇒ 三个平台词都补成宿主收的键（恒等映射），并记进 defaulted', () => {
  const { SHARED_HOST_REQUEST_KEYS } = require('./profile')
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  for (const word of ['text', 'reference_audio', 'reference_text']) {
    assert.equal(p.maps[word], SHARED_HOST_REQUEST_KEYS[word])
    assert.equal(p.maps[word], word, '宿主认的就是平台自己的词')
    assert.ok(p.defaulted.includes(`maps.${word}`), `maps.${word} 是平台替名片答的，要如实报出去`)
  }
})

test('通用宿主：拼出来的请求体用平台的词，参考音频与参考文本都带上', () => {
  const { assembleEnginePayload } = require('./payload')
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  const payload = assembleEnginePayload({ profile: p,
    canonical: { text: '你好', reference_audio: '/r.wav', reference_text: '原话' } })
  assert.deepStrictEqual(payload, { text: '你好', reference_audio: '/r.wav', reference_text: '原话' })
})

test('通用宿主：名片显式写了 null 或别的键名 ⇒ 照名片的来，只补完全没提的', () => {
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME,
    maps: { reference_text: null, reference_audio: 'clip' } }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.equal(p.maps.reference_text, undefined, '显式 null =「没这个概念」，不补')
  assert.equal(p.maps.reference_audio, 'clip', '显式写了别的键名就用名片的')
  assert.equal(p.maps.text, 'text', '没提的照补')
  assert.ok(!p.defaulted.includes('maps.reference_text'))
  assert.ok(!p.defaulted.includes('maps.reference_audio'))
  assert.ok(p.defaulted.includes('maps.text'))
})

test('启动脚本是引擎自带服务 ⇒ 参考音频、参考文本的 maps 一项都不补，名片写什么就是什么', () => {
  const own = { text: 'tx', reference_audio: 'clip_path', reference_text: 'clip_words' }
  const id = plant(completeManifest({
    runtime: { python: 'engines/x/.venv', entry: 'serve.py', ready_endpoint: '/ping' },
    maps: own,
  }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.deepStrictEqual(p.maps, own)
  assert.ok(!p.defaulted.some((k) => k.startsWith('maps.')))
})

test('推断出来的三个键与宿主真读的键一致：直接读 host.py 核对', () => {
  const { SHARED_HOST_REQUEST_KEYS } = require('./profile')
  assert.deepStrictEqual(Object.keys(SHARED_HOST_REQUEST_KEYS), ['text', 'reference_audio', 'reference_text'],
    '平台词汇表变了：宿主收哪几个词要跟着重新核对')
  const src = fs.readFileSync(path.join(__dirname, 'host.py'), 'utf8')
  const declared = (name) => {
    const m = new RegExp(`^${name} = "([^"]+)"$`, 'm').exec(src)
    assert.ok(m, `host.py 里找不到 ${name}`)
    return m[1]
  }
  assert.equal(declared('REQUEST_TEXT_KEY'), SHARED_HOST_REQUEST_KEYS.text)
  assert.equal(declared('REQUEST_REF_AUDIO_KEY'), SHARED_HOST_REQUEST_KEYS.reference_audio)
  assert.equal(declared('REQUEST_REF_TEXT_KEY'), SHARED_HOST_REQUEST_KEYS.reference_text)
  // 这几个常量真的用在请求体上：收得下（CORE_KEYS）、取得到（do_POST 与 request_ref_audio）。
  const core = /^CORE_KEYS = frozenset\(\{([\s\S]*?)\}\)/m.exec(src)
  assert.ok(core, 'host.py 里找不到 CORE_KEYS')
  for (const name of ['REQUEST_TEXT_KEY', 'REQUEST_REF_AUDIO_KEY', 'REQUEST_REF_TEXT_KEY']) {
    assert.ok(core[1].includes(name), `CORE_KEYS 里没有 ${name}：宿主会把它当成不认识的参数拦下`)
  }
  assert.ok(/body\.get\(REQUEST_REF_AUDIO_KEY\)/.test(src), 'host.py 不从 body 里取参考音频')
  assert.ok(/body\.get\(REQUEST_REF_TEXT_KEY\)/.test(src), 'host.py 不从 body 里取参考文本')
})

//  transport：平台和这台引擎怎么说话

test('⭐ 通用宿主 + 名片没写监听地址 ⇒ transport 是 stdio，base_url 是 null', () => {
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME, default_base_url: undefined }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.equal(p.transport, 'stdio')
  assert.equal(p.base_url, null)
})

test('通用宿主 + 名片写了 default_base_url ⇒ 照旧 http（名片作者明说要一个端口）', () => {
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME }))
  assert.equal(resolveEngineProfile(id, {}, { localTimings: null }).transport, 'http')
})

test('通用宿主 + base_url_env 在环境里有值 ⇒ http（有人在别处起好了它）', () => {
  const id = plant(completeManifest({ runtime: SHARED_RUNTIME, default_base_url: undefined,
    base_url_env: 'DEMO_STDIO_URL' }))
  const p = resolveEngineProfile(id, { DEMO_STDIO_URL: 'http://10.0.0.2:7000' }, { localTimings: null })
  assert.equal(p.transport, 'http')
  assert.equal(p.base_url, 'http://10.0.0.2:7000')
  // 变量没设 ⇒ 仍是 stdio
  assert.equal(resolveEngineProfile(id, {}, { localTimings: null }).transport, 'stdio')
})

test('引擎自带服务脚本、或没有 runtime ⇒ http，与以前一致', () => {
  const own = plant(completeManifest({
    runtime: { python: 'engines/x/.venv', entry: 'serve.py', ready_endpoint: '/ping' },
  }))
  assert.equal(resolveEngineProfile(own, {}, { localTimings: null }).transport, 'http')
  const none = plant(completeManifest())
  assert.equal(resolveEngineProfile(none, {}, { localTimings: null }).transport, 'http')
})

//  voice_defaults：哪些默认值跟着「保存为音色」落进 voices.json

test('⭐ 名片没写 voice_defaults ⇒ defaults 的键全进，但 maps 目标键不进', () => {
  const id = plant(completeManifest({
    maps: { text: 'format' },
    defaults: { split: 'cut5', format: 'wav', pace: 1 },
  }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.deepEqual(p.voice_defaults, ['split', 'pace'],
    '音色钉住 maps 目标键，等于让一条音色盖掉平台自己算出来的那个值')
})

test('名片写了 voice_defaults ⇒ 逐字按名单，连顺序也是名单的顺序', () => {
  const id = plant(completeManifest({
    defaults: { split: 'cut5', format: 'wav', pace: 1 },
    voice_defaults: ['format', 'split'],
  }))
  const p = resolveEngineProfile(id, {}, { localTimings: null })
  assert.deepEqual(p.voice_defaults, ['format', 'split'])
})

test('⛔ voice_defaults 里的键在 defaults 里没有 ⇒ 当场抛（值只许写在 defaults 一处）', () => {
  const id = plant(completeManifest({ defaults: { split: 'cut5' }, voice_defaults: ['top_k'] }))
  assert.throws(() => resolveEngineProfile(id, {}, { localTimings: null }),
    err => err.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /defaults 里没有这个键/.test(err.message))
})

test('⛔ voice_defaults 里点名 maps 目标键 ⇒ 当场抛（作者显然是想要它，得告诉他为什么不行）', () => {
  const id = plant(completeManifest({
    maps: { speed: 'pace' },
    defaults: { pace: 1, split: 'cut5' },
    voice_defaults: ['pace'],
  }))
  assert.throws(() => resolveEngineProfile(id, {}, { localTimings: null }),
    err => err.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /maps 把平台的一个词/.test(err.message))
})

//  languages：平台语种码在这台引擎里的原话

const { platformLangToEngine, legacyLangToEngine } = require('./profile')

test('名片没写 languages ⇒ 空表：平台码原样发给引擎', () => {
  const id = plant(completeManifest())
  const p = resolveEngineProfile(id, {})
  assert.deepEqual(p.language_map, {})
  assert.equal(platformLangToEngine(p.language_map, 'ja'), 'ja')
})

test('名片写了 languages ⇒ 逐条读出来，表里没有的语种原样发', () => {
  const id = plant(completeManifest({ languages: { ja: 'yose', zh: 'putong', auto: 'any' } }))
  const p = resolveEngineProfile(id, {})
  assert.deepEqual(p.language_map, { ja: 'yose', zh: 'putong', auto: 'any' })
  assert.equal(platformLangToEngine(p.language_map, 'ko'), 'ko', '名片没表态的语种平台不猜')
})

test('⛔ languages 的键不是平台语种码 ⇒ 当场抛，报错里列出合法键', () => {
  for (const bad of ['japanese', 'JA', 'all_ja']) {
    const id = plant(completeManifest({ languages: { [bad]: 'yose' } }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE'
        && new RegExp(`languages 里有键 '${bad}`).test(err.message)
        && /zh \/ yue \/ ja/.test(err.message),
      `${bad} 拼错了却静默放行，引擎收到的还是原值`)
  }
})

test('⛔ languages 的值不是非空字符串 ⇒ 当场抛', () => {
  for (const bad of ['', 7, null, { v: 'x' }]) {
    const id = plant(completeManifest({ languages: { ja: bad } }))
    assert.throws(() => resolveEngineProfile(id, {}),
      (err) => err.code === 'ENGINE_MANIFEST_INVALID_VALUE' && /languages\.ja 必须是非空字符串/.test(err.message),
      JSON.stringify(bad))
  }
})

test('platformLangToEngine：旧写法先归一成平台码，再换这台引擎的原话', () => {
  const map = { ja: 'yose', zh: 'putong' }
  assert.equal(platformLangToEngine(map, 'all_ja'), 'yose')
  assert.equal(platformLangToEngine(map, 'ALL_ZH'), 'putong')
  assert.equal(platformLangToEngine(map, ' ja '), 'yose')
  assert.equal(platformLangToEngine(map, 'fr'), 'fr')
})

test('legacyLangToEngine：只翻译写死的旧写法，其余一律原样', () => {
  const map = { ja: 'yose', zh: 'putong' }
  assert.equal(legacyLangToEngine(map, 'all_ja'), 'yose')
  assert.equal(legacyLangToEngine(map, 'ja'), 'ja', '这台引擎自己的裸码分支不是旧写法，不能顺手换掉')
  assert.equal(legacyLangToEngine(map, 'ALL_JA'), 'ALL_JA')
  assert.equal(legacyLangToEngine(map, 'fr'), 'fr')
})

//  pron：这台引擎能不能回答「文本 → 读音」的预览

test('没写 pron ⇒ pron_preview 是 null（「没有这个能力」，不是「还不知道」）', () => {
  assert.strictEqual(resolveEngineProfile(plant(completeManifest()), {}).pron_preview, null)
})

test('⭐ 名片声明的预览端点和请求体格式被原样读出来', () => {
  const id = plant(completeManifest({
    pron: { preview: { endpoint: '/custom/pron', request: 'json' } },
  }))
  assert.deepStrictEqual(resolveEngineProfile(id, {}).pron_preview,
    { endpoint: '/custom/pron', request: 'json' })
})

test('⛔ pron 写了却没写 preview ⇒ 当场拒绝（空壳等于没说）', () => {
  const id = plant(completeManifest({ pron: {} }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /pron\.preview/)
    return true
  })
})

test('⛔ pron.preview 上有不认识的键 ⇒ 拒绝，点名那个键', () => {
  const id = plant(completeManifest({
    pron: { preview: { endpoint: '/p', request: 'json', format: 'text' } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.equal(e.key, 'pron.preview.format')
    assert.match(e.message, /pron\.preview.*format/)
    return true
  })
})

test('⛔ endpoint 必须是以 / 开头的字符串：相对路径拼不出引擎地址', () => {
  for (const bad of ['pron/preview', '', 42, null]) {
    const id = plant(completeManifest({
      pron: { preview: { endpoint: bad, request: 'json' } },
    }))
    assert.throws(() => resolveEngineProfile(id, {}), (e) => {
      assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
      assert.match(e.message, /pron\.preview\.endpoint/)
      return true
    }, `endpoint = ${JSON.stringify(bad)} 应被拦下`)
  }
})

test('⛔ request 只认 "json"：平台不会发别的请求体', () => {
  const id = plant(completeManifest({
    pron: { preview: { endpoint: '/p', request: 'form' } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /pron\.preview\.request/)
    return true
  })
})

test('⛔ 通用宿主引擎声明 pron ⇒ 解析层拒绝：宿主只答 /tts', () => {
  const id = plant(completeManifest({
    runtime: { python: 'python', entry: 'lib/engines/host.py' },
    pron: { preview: { endpoint: '/pron/preview', request: 'json' } },
  }))
  assert.throws(() => resolveEngineProfile(id, {}), (e) => {
    assert.equal(e.code, 'ENGINE_MANIFEST_INVALID_VALUE')
    assert.match(e.message, /pron\.preview/)
    assert.match(e.message, /只答 \/tts/)
    return true
  })
})

test('⛔ 同一张名片改回自带服务脚本 ⇒ pron 照装（拦的是宿主，不是声明本身）', () => {
  const id = plant(completeManifest({
    runtime: { python: 'python', entry: 'serve.py', ready_endpoint: '/health' },
    pron: { preview: { endpoint: '/pron/preview', request: 'json' } },
  }))
  assert.deepStrictEqual(resolveEngineProfile(id, {}).pron_preview,
    { endpoint: '/pron/preview', request: 'json' })
})
