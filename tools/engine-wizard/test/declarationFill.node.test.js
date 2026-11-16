'use strict'
// declarationFill 守的 bug：名片缺 models.required / runtime.verify 的声明，
//   于是第 3 步只能说「目录在不在」、第 5 步的权重校验与环境校验「说不出来」
//   （checkpoints.js 的 ready:null 与 env_deep 无 spec）。
//
// 判据（与 manifestAutoFill 同一套纪律）：
//   该填：id 定了、素材拿得到（盘上文件 / call 段模块）、且那一格空着。
//   不该填：使用者声明过（非空就不覆盖）、素材拿不到（不硬猜）。

const { test } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const FILL = path.join(__dirname, '..', 'editor', 'declarationFill.js')

let requiredFromFiles, verifyModuleFromCall
let shouldFillModelsRequired, withModelsRequired, modelFilesOf
let shouldFillVerifySysPath, withVerifySysPath
let shouldFillVerifyImports, withVerifyImports
let shouldFillVerify, withAutoFilledVerify

test('加载 declarationFill.js', async () => {
  const m = await import(pathToFileURL(FILL).href)
  requiredFromFiles = m.requiredFromFiles
  verifyModuleFromCall = m.verifyModuleFromCall
  shouldFillModelsRequired = m.shouldFillModelsRequired
  withModelsRequired = m.withModelsRequired
  modelFilesOf = m.modelFilesOf
  shouldFillVerifySysPath = m.shouldFillVerifySysPath
  withVerifySysPath = m.withVerifySysPath
  shouldFillVerifyImports = m.shouldFillVerifyImports
  withVerifyImports = m.withVerifyImports
  shouldFillVerify = m.shouldFillVerify
  withAutoFilledVerify = m.withAutoFilledVerify
  for (const f of [requiredFromFiles, verifyModuleFromCall, shouldFillModelsRequired,
    withModelsRequired, modelFilesOf, shouldFillVerifySysPath, withVerifySysPath,
    shouldFillVerifyImports, withVerifyImports, shouldFillVerify,
    withAutoFilledVerify]) {
    assert.strictEqual(typeof f, 'function')
  }
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
// 盘上文件快照带着「按哪个 id 问来的」：换引擎时清掉 models 的下一个渲染
//   会拿着上一台的清单，不带 id 就挡不住（ZipVoice 曾写进 66 个 Kokoro 文件名）。
const SNAP = { id: 'e1', files: FILES }

test('id 定了、快照属于这台、盘上有文件、这一格空着 ⇒ 该填', () => {
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, SNAP), true)
  assert.strictEqual(
    shouldFillModelsRequired({ id: 'e1', models: { hint: 'x' } }, SNAP), true)
})

test('盘上只有杂质（没有可声明的文件）⇒ 不填（没法声明）', () => {
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, { id: 'e1', files: ['README.md'] }), false)
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, { id: 'e1', files: [] }), false)
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, { id: 'e1', files: null }), false)
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, null), false)
})

test('引擎 id 还没定 ⇒ 不填', () => {
  assert.strictEqual(shouldFillModelsRequired({}, SNAP), false)
  assert.strictEqual(shouldFillModelsRequired(null, SNAP), false)
})

test('⭐⭐⭐ 快照是另一台引擎的 ⇒ 不填（换引擎的瞬间就会撞上）', () => {
  // 从 A 切到 B：models 已被换引擎清空，而盘上文件清单还是 A 的。
  //   照它填 ⇒ B 的名片里写着 A 的文件名。
  assert.strictEqual(
    shouldFillModelsRequired({ id: 'B' }, { id: 'A', files: ['a_model.pt'] }), false)
  // 反过来也一样，且与文件多少无关：这份清单确实非空，只是不属于 B。
  assert.strictEqual(
    shouldFillModelsRequired({ id: 'ZipVoice' },
      { id: 'kokoro', files: ['kokoro-v1_0.pth', 'voices/af_heart.pt'] }), false)
})

test('⭐⭐ 裸数组（没有身份）⇒ 不填：证明不了这份清单属于谁', () => {
  assert.strictEqual(shouldFillModelsRequired({ id: 'e1' }, FILES), false)
})

test('使用者声明过（非空 required）⇒ 不覆盖他的判断', () => {
  assert.strictEqual(
    shouldFillModelsRequired(
      { id: 'e1', models: { required: ['only_this.pt'] } }, SNAP),
    false)
})

test('声明成空数组（= 没声明任何文件）⇒ 该填', () => {
  assert.strictEqual(
    shouldFillModelsRequired({ id: 'e1', models: { required: [] } }, SNAP), true)
})

// ---- modelFilesOf：从快照里取文件 ----

test('快照取文件：对象取 files，裸数组原样，其它给空数组', () => {
  assert.deepStrictEqual(modelFilesOf(SNAP), FILES)
  assert.deepStrictEqual(modelFilesOf(FILES), FILES)
  assert.deepStrictEqual(modelFilesOf(null), [])
  assert.deepStrictEqual(modelFilesOf({ id: 'e1' }), [])
  assert.deepStrictEqual(modelFilesOf({ id: 'e1', files: null }), [])
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
