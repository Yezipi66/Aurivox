'use strict'
// declarationFill 守的 bug：名片缺 models.required / runtime.verify 的声明，
//   于是第 3 步只能说「目录在不在」、第 5 步的权重校验与环境校验「说不出来」
//   （checkpoints.js 的 ready:null 与 env_deep 无 spec）。
//
// 判据（与 manifestAutoFill 同一套纪律）：
//   该填：id 定了、素材拿得到（盘上文件 / call 段模块）、且那一格空着。
//   不该填：使用者声明过（非空就不覆盖）、素材拿不到（不硬猜）。
// 置信度（确定=绿，猜的=黄）：models.required 与 verify.imports 是确定（绿），
//   verify.sys_path 是猜的（黄），界面按 FILL_NOTES 标。

const { test } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const FILL = path.join(__dirname, '..', 'editor', 'declarationFill.js')

let requiredFromFiles, verifyModuleFromCall
let shouldFillModelsRequired, withModelsRequired
let shouldFillVerifySysPath, withVerifySysPath
let shouldFillVerifyImports, withVerifyImports
let shouldFillVerify, withAutoFilledVerify, FILL_NOTES, describeFilledNotes

test('加载 declarationFill.js', async () => {
  const m = await import(pathToFileURL(FILL).href)
  requiredFromFiles = m.requiredFromFiles
  verifyModuleFromCall = m.verifyModuleFromCall
  shouldFillModelsRequired = m.shouldFillModelsRequired
  withModelsRequired = m.withModelsRequired
  shouldFillVerifySysPath = m.shouldFillVerifySysPath
  withVerifySysPath = m.withVerifySysPath
  shouldFillVerifyImports = m.shouldFillVerifyImports
  withVerifyImports = m.withVerifyImports
  shouldFillVerify = m.shouldFillVerify
  withAutoFilledVerify = m.withAutoFilledVerify
  FILL_NOTES = m.FILL_NOTES
  describeFilledNotes = m.describeFilledNotes
  for (const f of [requiredFromFiles, verifyModuleFromCall, shouldFillModelsRequired,
    withModelsRequired, shouldFillVerifySysPath, withVerifySysPath,
    shouldFillVerifyImports, withVerifyImports, shouldFillVerify,
    withAutoFilledVerify]) {
    assert.strictEqual(typeof f, 'function')
  }
  assert.ok(FILL_NOTES && typeof FILL_NOTES === 'object')
})

// ---- requiredFromFiles：盘上文件折成声明 ----

test('README / LICENSE / 校验和 / 点文件 / .md / .lock 不算权重', () => {
  const files = [
    'README.md', 'LICENSE', 'NOTICE.txt', 'CHANGELOG.md',
    'model.sha256', 'CHECKSUMS', 'm.bin.lock', '.DS_Store', '.cache_hint',
    'docs.md',
  ]
  assert.deepStrictEqual(requiredFromFiles(files), [])
})

test('词表与配置文件要留下（有的引擎把它们算进 required）', () => {
  const files = ['vocab.txt', 'config.json', 'spk.yaml', 'm.safetensors']
  assert.deepStrictEqual(requiredFromFiles(files),
    ['config.json', 'm.safetensors', 'spk.yaml', 'vocab.txt'])
})

test('嵌套子目录的权重照原样保留（LLM/、BiCodec/ 这种布局）', () => {
  const files = ['LLM/qwen.pt', 'BiCodec/bicodec.pt', 'README.md']
  assert.deepStrictEqual(requiredFromFiles(files),
    ['BiCodec/bicodec.pt', 'LLM/qwen.pt'])
})

test('结果排序稳定，且不改原数组', () => {
  const src = ['b.pt', 'a.pt']
  const out = requiredFromFiles(src)
  assert.deepStrictEqual(out, ['a.pt', 'b.pt'])
  assert.deepStrictEqual(src, ['b.pt', 'a.pt'], '原数组被改了')
})

test('不是数组（端点没送来）⇒ 空', () => {
  assert.deepStrictEqual(requiredFromFiles(null), [])
  assert.deepStrictEqual(requiredFromFiles(undefined), [])
  assert.deepStrictEqual(requiredFromFiles('a.pt'), [])
})

// ---- verifyModuleFromCall：从 call 段推模块 ----

test('python 形态：模块名就是 call.module', () => {
  assert.strictEqual(
    verifyModuleFromCall({ call: { kind: 'python', module: 'sparktts.api' } }),
    'sparktts.api')
})

test('没写 kind 时按 python 形态读 call.module', () => {
  assert.strictEqual(
    verifyModuleFromCall({ call: { module: 'sparktts.api' } }), 'sparktts.api')
})

test('cli 形态：取 argv 里 -m 后面那个', () => {
  assert.strictEqual(
    verifyModuleFromCall({ call: { kind: 'cli', argv: ['python', '-m', 'sparktts.server'] } }),
    'sparktts.server')
})

test('cli 形态：-m 是最后一个（后面没目标）⇒ 推不出来', () => {
  assert.strictEqual(
    verifyModuleFromCall({ call: { kind: 'cli', argv: ['python', '-m'] } }), null)
})

test('cli 形态：直接跑脚本文件（没有 -m）⇒ 推不出来', () => {
  assert.strictEqual(
    verifyModuleFromCall({ call: { kind: 'cli', argv: ['python', 'server.py'] } }), null)
})

test('call 段没有 / 模块空着 ⇒ 推不出来（不硬猜）', () => {
  assert.strictEqual(verifyModuleFromCall({}), null)
  assert.strictEqual(verifyModuleFromCall({ call: { kind: 'python', module: '' } }), null)
  assert.strictEqual(verifyModuleFromCall({ call: { kind: 'python' } }), null)
  assert.strictEqual(verifyModuleFromCall(null), null)
})

// ---- models.required：该不该填 ----

const FILES = ['LLM/qwen.pt', 'BiCodec/bcodec.pt', 'README.md']

test('id 定了、盘上有文件、这一格空着 ⇒ 该填', () => {
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, FILES), true)
  assert.strictEqual(
    shouldFillModelsRequired({ id: 'e1', models: { hint: 'x' } }, FILES), true)
})

test('盘上只有杂质（没有可声明的文件）⇒ 不填（没法声明）', () => {
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, ['README.md']), false)
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, []), false)
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, null), false)
})

test('引擎 id 还没定 ⇒ 不填', () => {
  assert.strictEqual(shouldFillModelsRequired({}, FILES), false)
  assert.strictEqual(shouldFillModelsRequired(null, FILES), false)
})

test('使用者声明过（非空 required）⇒ 不覆盖他的判断', () => {
  assert.strictEqual(
    shouldFillModelsRequired(
      { id: 'e1', models: { required: ['only_this.pt'] } }, FILES),
    false)
})

test('声明成空数组（= 没声明任何文件）⇒ 该填', () => {
  assert.strictEqual(
    shouldFillModelsRequired({ id: 'e1', models: { required: [] } }, FILES), true)
})

// ---- models.required：填出来的样子 ----

test('填完 required 是盘上文件清单，models 段别的键不动', () => {
  const before = { id: 'e1', models: { hint: '去哪下', source: { url: 'u' } } }
  const after = withModelsRequired(before, ['LLM/qwen.pt', 'BiCodec/bcodec.pt'])
  assert.deepStrictEqual(after.models.required, ['LLM/qwen.pt', 'BiCodec/bcodec.pt'])
  assert.strictEqual(after.models.hint, '去哪下')
  assert.strictEqual(after.models.source.url, 'u')
  assert.strictEqual(before.models.required, undefined, '原对象被动了')
})

test('名片没有 models 段 ⇒ 填完会多出一个', () => {
  const after = withModelsRequired({ id: 'e1' }, ['a.pt'])
  assert.deepStrictEqual(after.models.required, ['a.pt'])
})

// ---- verify.sys_path：该不该填 ----

test('sys_path 空着且 id 定了 ⇒ 该填', () => {
  assert.strictEqual(shouldFillVerifySysPath({ id: 'e1' }), true)
  assert.strictEqual(shouldFillVerifySysPath({ id: 'e1', runtime: {} }), true)
  assert.strictEqual(shouldFillVerifySysPath(
    { id: 'e1', runtime: { verify: {} } }), true)
  assert.strictEqual(shouldFillVerifySysPath(
    { id: 'e1', runtime: { verify: { sys_path: [] } } }), true)
})

test('sys_path 已经声明 ⇒ 不动它', () => {
  assert.strictEqual(shouldFillVerifySysPath(
    { id: 'e1', runtime: { verify: { sys_path: ['engines/e1/src'] } } }), false)
})

test('id 还没定 ⇒ 不填（算不出克隆根）', () => {
  assert.strictEqual(shouldFillVerifySysPath({}), false)
  assert.strictEqual(shouldFillVerifySysPath(null), false)
})

test('填出来的 sys_path 是克隆根，runtime 别的键不动', () => {
  const before = { id: 'e1', runtime: { python: 'engines/e1/.venv', verify: { ready: false } } }
  const after = withVerifySysPath(before)
  assert.deepStrictEqual(after.runtime.verify.sys_path, ['engines/e1'])
  assert.strictEqual(after.runtime.python, 'engines/e1/.venv')
  assert.strictEqual(after.runtime.verify.ready, false)
  assert.strictEqual(before.runtime.verify.sys_path, undefined, '原对象被动了')
})

// ---- verify.imports：该不该填 ----

test('imports 空着且 call 有模块 ⇒ 该填', () => {
  assert.strictEqual(shouldFillVerifyImports(
    { id: 'e1', call: { kind: 'python', module: 'sparktts.api' } }), true)
  assert.strictEqual(shouldFillVerifyImports(
    { call: { kind: 'python', module: 'sparktts.api' }, runtime: { verify: {} } }), true)
  assert.strictEqual(shouldFillVerifyImports(
    { call: { kind: 'python', module: 'sparktts.api' },
      runtime: { verify: { imports: [] } } }), true)
})

test('imports 已经有（扫描或使用者写过）⇒ 不覆盖', () => {
  assert.strictEqual(shouldFillVerifyImports(
    { call: { kind: 'python', module: 'sparktts.api' },
      runtime: { verify: { imports: [{ module: 'x', class: 'X' }] } } }), false)
})

test('call 推不出模块 ⇒ 不填（不硬猜）', () => {
  assert.strictEqual(shouldFillVerifyImports({ id: 'e1' }), false)
  assert.strictEqual(shouldFillVerifyImports(
    { id: 'e1', call: { kind: 'cli', argv: ['python', 'server.py'] } }), false)
})

test('填出来的 imports 是 module-only（env_probe 认的最小形状）', () => {
  const before = { id: 'e1', call: { kind: 'python', module: 'sparktts.api' },
    runtime: { python: 'engines/e1/.venv', verify: { sys_path: ['engines/e1'] } } }
  const after = withVerifyImports(before)
  assert.deepStrictEqual(after.runtime.verify.imports, [{ module: 'sparktts.api' }])
  assert.deepStrictEqual(after.runtime.verify.sys_path, ['engines/e1'],
    'sys_path 是使用者/别处声明过的，不许连带改掉')
  assert.strictEqual(after.runtime.python, 'engines/e1/.venv')
  assert.strictEqual(before.runtime.verify.imports, undefined, '原对象被动了')
})

// ---- 合起来：一个 effect 填完 verify 段 ----

test('shouldFillVerify：两格里任一格能填就 true', () => {
  assert.strictEqual(shouldFillVerify({ id: 'e1' }), true)
  assert.strictEqual(shouldFillVerify(
    { id: 'e1', call: { kind: 'python', module: 'm' } }), true)
  assert.strictEqual(shouldFillVerify({
    id: 'e1',
    call: { kind: 'python', module: 'm' },
    runtime: { verify: { sys_path: ['engines/e1'], imports: [{ module: 'm' }] } },
  }), false, '两格都满了还填什么')
})

test('withAutoFilledVerify：两格都缺 ⇒ 两格都填', () => {
  const after = withAutoFilledVerify(
    { id: 'e1', call: { kind: 'python', module: 'sparktts.api' } })
  assert.deepStrictEqual(after.runtime.verify.sys_path, ['engines/e1'])
  assert.deepStrictEqual(after.runtime.verify.imports, [{ module: 'sparktts.api' }])
})

test('withAutoFilledVerify：只有 imports 缺 ⇒ 只填 imports，sys_path 不动', () => {
  const after = withAutoFilledVerify({
    id: 'e1', call: { kind: 'python', module: 'm' },
    runtime: { verify: { sys_path: ['engines/e1/src'] } },
  })
  assert.deepStrictEqual(after.runtime.verify.sys_path, ['engines/e1/src'])
  assert.deepStrictEqual(after.runtime.verify.imports, [{ module: 'm' }])
})

test('withAutoFilledVerify：call 没模块 ⇒ 只填 sys_path（imports 不硬猜）', () => {
  const after = withAutoFilledVerify({ id: 'e1' })
  assert.deepStrictEqual(after.runtime.verify.sys_path, ['engines/e1'])
  assert.strictEqual(after.runtime.verify.imports, undefined)
})

test('withAutoFilledVerify：两格都满 ⇒ 原样返回', () => {
  const m = {
    id: 'e1', call: { kind: 'python', module: 'm' },
    runtime: { verify: { sys_path: ['engines/e1'], imports: [{ module: 'm' }] } },
  }
  assert.deepStrictEqual(withAutoFilledVerify(m), m)
})

test('填两次不会叠（幂等）', () => {
  const once = withAutoFilledVerify(
    { id: 'e1', call: { kind: 'python', module: 'm' } })
  const twice = withAutoFilledVerify(once)
  assert.deepStrictEqual(twice.runtime.verify, once.runtime.verify)
})

// ---- 置信度标注（确定=绿，猜的=黄）----

test('FILL_NOTES：该确定的确定、该猜的标成猜', () => {
  assert.strictEqual(FILL_NOTES.models_required.level, 'certain',
    '盘上实际下过的文件，确定')
  assert.strictEqual(FILL_NOTES.verify_imports.level, 'certain',
    '与 call 段同一个模块，call 定了它就跟着定')
  assert.strictEqual(FILL_NOTES.verify_sys_path.level, 'guess',
    '克隆根是猜的：src 布局要改，必须标成猜')
})

test('FILL_NOTES：每条都有中英两句人话', () => {
  for (const [k, n] of Object.entries(FILL_NOTES)) {
    assert.ok(typeof n.en === 'string' && n.en, `${k} 缺英文说明`)
    assert.ok(typeof n.zh === 'string' && n.zh, `${k} 缺中文说明`)
    assert.ok(['certain', 'guess'].includes(n.level), `${k} 的 level 只能是 certain/guess`)
  }
})

// ---- describeFilledNotes：界面上该标哪几条 ----

test('三格都处在自动填的形状 ⇒ 三条都标，levels 各归各位', () => {
  const m = withModelsRequired(
    withAutoFilledVerify(
      { id: 'e1', call: { kind: 'python', module: 'sparktts.api' } }),
    ['LLM/qwen.pt', 'BiCodec/bcodec.pt'])
  const notes = describeFilledNotes(m, FILES)
  assert.deepStrictEqual(notes.map((n) => n.key),
    ['models_required', 'verify_imports', 'verify_sys_path'])
  assert.deepStrictEqual(notes.map((n) => n.level),
    ['certain', 'certain', 'guess'])
})

test('使用者把 sys_path 改走了 ⇒ 不再标这一格（已是他的判断）', () => {
  const m = {
    id: 'e1', call: { kind: 'python', module: 'sparktts.api' },
    models: { required: ['LLM/qwen.pt', 'BiCodec/bcodec.pt'] },
    runtime: { verify: { sys_path: ['engines/e1/src'], imports: [{ module: 'sparktts.api' }] } },
  }
  const notes = describeFilledNotes(m, FILES)
  assert.deepStrictEqual(notes.map((n) => n.key), ['models_required', 'verify_imports'])
})

test('models.required 与盘上清单不一致（使用者增删过）⇒ 不标', () => {
  const m = {
    id: 'e1',
    models: { required: ['only_this.pt'] },
  }
  assert.deepStrictEqual(describeFilledNotes(m, FILES), [])
})

test('verify.imports 与 call 段不同模块（使用者改过）⇒ 不标', () => {
  const m = {
    id: 'e1', call: { kind: 'python', module: 'sparktts.api' },
    runtime: { verify: { imports: [{ module: 'other.module' }] } },
  }
  assert.deepStrictEqual(describeFilledNotes(m, FILES), [])
})

test('id 没定 / 空名片 ⇒ 没有可标的', () => {
  assert.deepStrictEqual(describeFilledNotes({}, FILES), [])
  assert.deepStrictEqual(describeFilledNotes(null, FILES), [])
})

test('盘上没有文件清单（第 3 步没下）⇒ models 那条标不出来', () => {
  const m = withModelsRequired(
    { id: 'e1', models: { required: ['a.pt'] } }, ['a.pt'])
  describeFilledNotes(m, FILES) // 有清单时标得出
  assert.deepStrictEqual(describeFilledNotes(m, null).map((n) => n.key), [])
})

// ---- 活代码里不许出现具体引擎名 ----
test('declarationFill.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm', 'spark' + '-tts']
  const fs = require('node:fs')
  const src = fs.readFileSync(FILL, 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})
