'use strict'

//  scan.js — 资产扫描逻辑
// 用 require.cache 注入 mock 依赖，用 tmpdir 构造测试目录与临时 engines/ 目录。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// ---- 用 require.cache 注入 mock 依赖 ----------------------------------------

const tmpAssetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'))
const tmpEnginesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-engines-'))
// registry 在模块加载时读这个变量，所以要在 require('./scan') 之前设好。
process.env.AURIVOX_EXTRA_ENGINES_DIR = tmpEnginesDir

function putEngine(id, scan = null) {
  fs.mkdirSync(path.join(tmpEnginesDir, id), { recursive: true })
  fs.writeFileSync(path.join(tmpEnginesDir, id, 'manifest.json'), JSON.stringify({ id, label: id }))
  if (scan) fs.writeFileSync(path.join(tmpEnginesDir, id, 'scan.json'), JSON.stringify(scan))
}

// 原样写盘的一份 scan.json（无法读取的声明要用它，JSON.stringify 造不出非法 JSON）。
function putEngineRaw(id, raw) {
  fs.mkdirSync(path.join(tmpEnginesDir, id), { recursive: true })
  fs.writeFileSync(path.join(tmpEnginesDir, id, 'manifest.json'), JSON.stringify({ id, label: id }))
  fs.writeFileSync(path.join(tmpEnginesDir, id, 'scan.json'), raw)
}

putEngine('scan-eng-alpha', {
  language_from_name: ['-(?<lang>[A-Z]{2})-take\\d+\\.bin$'],
  steps_from_name: ['take(?<step>\\d+)\\.bin$'],
  version: {
    slot: 'weights',
    header_map: { AB: 'rev9' },
    from_name: [{ pattern: '-beta', value: 'rev7' }],
    from_size: [{ below_bytes: 1024, value: 'rev1' }, { value: 'rev0' }],
  },
})
putEngine('scan-eng-plain')
// 声明了但无法读取：顶层有一个平台不认识的键。
putEngine('scan-eng-broken', { langauge_from_name: ['(?<lang>oops)'] })
putEngineRaw('scan-eng-notjson', '{ "language_from_name": [ ')

// 解析 scan.js 依赖的真实路径
const constsPath = require.resolve('./consts')
const modelLayoutPath = require.resolve('../assets/modelLayout')
const pipelineIdentityPath = require.resolve('../training/pipelineIdentity')
const audioDurationPath = require.resolve('./audioDuration')
const transcriptPath = require.resolve('./transcript')

const layoutState = { engines: [], models: {} }

// 注入 mock
require.cache[constsPath] = {
  id: constsPath,
  filename: constsPath,
  loaded: true,
  exports: { ASSETS_DIR: tmpAssetsDir, DEFAULT_LANGUAGE: 'auto' },
}
require.cache[modelLayoutPath] = {
  id: modelLayoutPath,
  filename: modelLayoutPath,
  loaded: true,
  exports: {
    scanVoiceModels: (voiceDir) =>
      typeof layoutState.models === 'function' ? layoutState.models(voiceDir) : layoutState.models,
    legacyDirsPresent: () => [],
    enginesWithModels: () => layoutState.engines,
    modelsRoot: (voiceDir) => path.join(voiceDir, 'models'),
  },
}
require.cache[pipelineIdentityPath] = {
  id: pipelineIdentityPath,
  filename: pipelineIdentityPath,
  loaded: true,
  exports: {
    TRAINING_ENGINE_ID: 'mock-engine',
    TRAINING_SLOTS: {
      gpt: { name: 'gpt', ext: '.ckpt' },
      sovits: { name: 'sovits', ext: '.pth' },
    },
  },
}
require.cache[audioDurationPath] = {
  id: audioDurationPath,
  filename: audioDurationPath,
  loaded: true,
  exports: { getAudioDuration: () => 1.5 },
}
require.cache[transcriptPath] = {
  id: transcriptPath,
  filename: transcriptPath,
  loaded: true,
  exports: {
    inspectTranscriptList: () => ({ status: 'none' }),
    buildSegmentsFor: () => null,
    generateSegments: () => ({ matched: 0 }),
  },
}

const {
  listVoiceAssets,
  deriveLanguageFromModels,
  annotateModelLabels,
  scanVoiceDir,
  fullScan,
  detectAssetState,
} = require('./scan')

function tmpdir(label) {
  return fs.mkdtempSync(path.join(tmpAssetsDir, `${label}-`))
}

function put(dir, rel, content = 'x') {
  const fp = path.join(dir, rel)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
  return fp
}

function clearAssets() {
  for (const e of fs.readdirSync(tmpAssetsDir)) {
    fs.rmSync(path.join(tmpAssetsDir, e), { recursive: true, force: true })
  }
}

//  annotateModelLabels — 按引擎 scan.json 贴标签

test('annotateModelLabels: 给声明了的引擎贴 steps 和 version', () => {
  const dir = tmpdir('labels')
  const fp = put(dir, 'model-take12.bin', Buffer.from('AB00'))
  const models = {
    'scan-eng-alpha': {
      weights: [{ name: 'model-take12.bin', path: fp, is_dir: false }],
      other: [{ name: 'model-take12.bin', path: fp, is_dir: false }],
    },
  }
  annotateModelLabels(models)
  assert.equal(models['scan-eng-alpha'].weights[0].steps, 12)
  assert.equal(models['scan-eng-alpha'].weights[0].version, 'rev9')
  assert.equal(models['scan-eng-alpha'].other[0].steps, 12)
  assert.equal(models['scan-eng-alpha'].other[0].version, undefined)
})

test('annotateModelLabels: 没有 scan.json 的引擎不贴标签，也不抛出', () => {
  const models = { 'scan-eng-plain': { weights: [{ name: 'model-take12.bin', path: '/nope' }] } }
  const skipped = annotateModelLabels(models)
  assert.deepEqual(skipped.map(s => [s.engine_id, s.reason]), [['scan-eng-plain', 'no_scan_file']])
  assert.match(skipped[0].text, /没有 scan\.json/, 'note 要给出可读说明，不能只有 reason token')
  assert.equal(models['scan-eng-plain'].weights[0].steps, undefined)
  assert.equal(models['scan-eng-plain'].weights[0].version, undefined)
})

test('annotateModelLabels: engines/ 下有目录但平台未安装该引擎 ⇒ 说明是引擎未安装', () => {
  const models = { 'scan-eng-nowhere': { weights: [{ name: 'model-take12.bin', path: '/nope' }] } }
  const skipped = annotateModelLabels(models)
  assert.deepEqual(skipped.map(s => [s.engine_id, s.reason]), [['scan-eng-nowhere', 'engine_not_installed']])
  assert.match(skipped[0].text, /engines\//)
})

test('annotateModelLabels: 声明齐的引擎不记进 skipped', () => {
  const dir = tmpdir('labels-ok')
  const fp = put(dir, 'model-take12.bin', Buffer.from('AB00'))
  const models = { 'scan-eng-alpha': { weights: [{ name: 'model-take12.bin', path: fp }] } }
  assert.deepEqual(annotateModelLabels(models), [])
})

test('annotateModelLabels: 空输入返回空列表', () => {
  assert.deepEqual(annotateModelLabels(null), [])
  assert.deepEqual(annotateModelLabels({}), [])
})

test('⭐ annotateModelLabels: 无法读取的声明只影响它自己，同一角色的其他引擎照常贴标签', () => {
  const dir = tmpdir('isolate')
  const fp = put(dir, 'model-take12.bin', Buffer.from('AB00'))
  const models = {
    'scan-eng-alpha': { weights: [{ name: 'model-take12.bin', path: fp }] },
    'scan-eng-broken': { weights: [{ name: 'b.bin', path: '/nope' }] },
  }
  const skipped = annotateModelLabels(models)
  assert.equal(models['scan-eng-alpha'].weights[0].version, 'rev9',
    '同一角色里，好引擎的标签还在')
  assert.deepEqual(skipped.map(s => [s.engine_id, s.reason]), [['scan-eng-broken', 'invalid_scan_file']])
  assert.equal(skipped[0].key, 'langauge_from_name', 'note 点名要改的是哪一个键')
  assert.match(skipped[0].file, /scan-eng-broken[\\/]scan\.json$/, 'note 点名要改的是哪一个文件')
  assert.match(skipped[0].text, /langauge_from_name/, '返回引擎自己的报错原文，便于对照修改')
})

test('annotateModelLabels: 声明不是合法 JSON 的引擎也只出它自己那条 note', () => {
  const models = { 'scan-eng-notjson': { weights: [{ name: 'a.bin', path: '/nope' }] } }
  const skipped = annotateModelLabels(models)
  assert.deepEqual(skipped.map(s => [s.engine_id, s.reason]), [['scan-eng-notjson', 'invalid_scan_file']])
  assert.match(skipped[0].text, /不是合法 JSON/)
})


test('scanVoiceDir: 引擎未写 scan.json ⇒ meta 记下约定缺在哪一层', () => {
  layoutState.models = { 'scan-eng-plain': { weights: [{ name: 'a.bin', path: '/nope' }] } }
  const voiceDir = tmpdir('labelgap')
  fs.mkdirSync(voiceDir, { recursive: true })
  const meta = scanVoiceDir(path.basename(voiceDir), voiceDir)
  assert.deepEqual(meta.assets.scan_convention_notes.map(s => [s.engine_id, s.reason]),
    [['scan-eng-plain', 'no_scan_file']])
  layoutState.models = {}
})

test('⭐ scanVoiceDir: 无法读取的声明不让这次扫描抛出', () => {
  // 训练发布（finalize.js 的 _publish）直接调 scanVoiceDir，中间没包 try：
  // 第三方引擎的声明无法读取，不该让整次发布失败。
  layoutState.models = { 'scan-eng-broken': { weights: [{ name: 'b.bin', path: '/nope' }] } }
  const voiceDir = tmpdir('finalize-safe')
  fs.mkdirSync(voiceDir, { recursive: true })
  const meta = scanVoiceDir(path.basename(voiceDir), voiceDir)
  assert.deepEqual(meta.assets.scan_convention_notes.map(s => [s.engine_id, s.reason]),
    [['scan-eng-broken', 'invalid_scan_file']])
  layoutState.models = {}
})

test('scanVoiceDir: 约定齐的引擎不在 meta 里留任何痕迹', () => {
  const dir = tmpdir('labels-meta-ok')
  const fp = put(dir, 'model-take12.bin', Buffer.from('AB00'))
  layoutState.models = { 'scan-eng-alpha': { weights: [{ name: 'model-take12.bin', path: fp }] } }
  const voiceDir = tmpdir('labelok')
  fs.mkdirSync(voiceDir, { recursive: true })
  const meta = scanVoiceDir(path.basename(voiceDir), voiceDir)
  assert.equal(meta.assets.scan_convention_notes, undefined,
    'GSV 那条路径的 meta 不能因为这条诊断多出一个键')
  assert.equal(meta.assets.models['scan-eng-alpha'].weights[0].version, 'rev9')
  layoutState.models = {}
})

// 标签只从引擎目录里的 scan.json 读，与盘上文件名的形式无关。
// 这里刻意用 GSV 的命名：没有那份声明，再熟悉的名字也读不出约定。

test('⭐ 引擎目录里没 scan.json ⇒ GSV 命名的模型标签全空', () => {
  layoutState.engines = ['scan-eng-plain']
  const dir = tmpdir('gsv-names')
  const ckpt = put(dir, 'role_ja-e10.ckpt', Buffer.from('0000'))
  const pth = put(dir, 'm_v2ProPlus_e10_s100.pth', Buffer.from('PK00'))
  layoutState.models = {
    'scan-eng-plain': { gpt: [{ name: path.basename(ckpt), path: ckpt }], sovits: [{ name: path.basename(pth), path: pth }] },
  }
  const voiceDir = tmpdir('gsv-names-voice')
  fs.mkdirSync(voiceDir, { recursive: true })
  const meta = scanVoiceDir(path.basename(voiceDir), voiceDir)
  assert.equal(meta.assets.models['scan-eng-plain'].gpt[0].steps, undefined)
  assert.equal(meta.assets.models['scan-eng-plain'].sovits[0].version, undefined)
  assert.equal(meta.language, 'auto')
  assert.deepEqual(meta.assets.scan_convention_notes.map(s => [s.engine_id, s.reason]),
    [['scan-eng-plain', 'no_scan_file']])
  layoutState.models = {}
  layoutState.engines = []
})

test('⭐ 同一台引擎、同样的文件名，目录里有 scan.json 就贴得上', () => {
  layoutState.engines = ['scan-eng-alpha']
  const dir = tmpdir('alpha-names')
  const bin = put(dir, 'role-ZZ-take7.bin', Buffer.from('AB00'))
  layoutState.models = { 'scan-eng-alpha': { weights: [{ name: path.basename(bin), path: bin }] } }
  const voiceDir = tmpdir('alpha-names-voice')
  fs.mkdirSync(voiceDir, { recursive: true })
  const meta = scanVoiceDir(path.basename(voiceDir), voiceDir)
  assert.equal(meta.assets.models['scan-eng-alpha'].weights[0].steps, 7)
  assert.equal(meta.assets.models['scan-eng-alpha'].weights[0].version, 'rev9')
  layoutState.models = {}
  layoutState.engines = []
})

//  deriveLanguageFromModels — 语言推导

test('deriveLanguageFromModels: 按引擎 scan.json 的命名从文件名推导语言', () => {
  layoutState.engines = ['scan-eng-alpha']
  const dir = tmpdir('lang')
  put(dir, 'models/scan-eng-alpha/weights/voice-JA-take3.bin', 'x')
  assert.equal(deriveLanguageFromModels(dir), 'ja')
})

test('deriveLanguageFromModels: 没有 scan.json 的引擎不推断', () => {
  layoutState.engines = ['scan-eng-plain']
  const dir = tmpdir('lang-plain')
  put(dir, 'models/scan-eng-plain/weights/voice_ja-e10.ckpt', 'x')
  assert.equal(deriveLanguageFromModels(dir), null)
  layoutState.engines = []
})

//  scanVoiceDir — 目录扫描

test('scanVoiceDir: 空目录生成基本 meta', () => {
  const voiceId = 'testvoice'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(voiceDir, { recursive: true })
  const meta = scanVoiceDir(voiceId, voiceDir)
  assert.equal(meta.id, voiceId)
  assert.equal(meta.display_name, voiceId)
  assert.equal(meta.language, 'auto')
  assert.ok(meta.assets)
  assert.deepEqual(meta.assets.models, {}) // mock 返回 {}
})

test('scanVoiceDir: 保留已有 meta 的 display_name 和 language', () => {
  const voiceId = 'testvoice2'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(voiceDir, { recursive: true })
  const prevMeta = {
    id: voiceId,
    display_name: 'My Voice',
    language: 'ja',
    mode: 'internal',
  }
  fs.writeFileSync(path.join(voiceDir, 'meta.json'), JSON.stringify(prevMeta))
  const meta = scanVoiceDir(voiceId, voiceDir)
  assert.equal(meta.display_name, 'My Voice')
  assert.equal(meta.language, 'ja')
})

test('scanVoiceDir: 扫描 raw 目录', () => {
  const voiceId = 'testvoice3'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(path.join(voiceDir, 'raw'), { recursive: true })
  put(voiceDir, 'raw/clip001.wav', 'x')
  put(voiceDir, 'raw/clip002.wav', 'x')
  const meta = scanVoiceDir(voiceId, voiceDir)
  assert.ok(meta.assets.raw)
  assert.equal(meta.assets.raw.file_count, 2)
  assert.equal(meta.assets.raw.total_duration, 3.0) // 2 * 1.5
})

test('scanVoiceDir: 扫描 slicer_opt 目录', () => {
  const voiceId = 'testvoice4'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(path.join(voiceDir, 'slicer_opt'), { recursive: true })
  put(voiceDir, 'slicer_opt/seg001.wav', 'x')
  put(voiceDir, 'slicer_opt/seg002.wav', 'x')
  put(voiceDir, 'slicer_opt/seg003.wav', 'x')
  const meta = scanVoiceDir(voiceId, voiceDir)
  assert.ok(meta.assets.slices)
  assert.equal(meta.assets.slices.file_count, 3)
})

test('scanVoiceDir: 扫描 references 目录', () => {
  const voiceId = 'testvoice5'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(path.join(voiceDir, 'references'), { recursive: true })
  put(voiceDir, 'references/ref1.wav', 'x')
  put(voiceDir, 'references/ref2.wav', 'x')
  const meta = scanVoiceDir(voiceId, voiceDir)
  assert.ok(meta.assets.references)
  assert.equal(meta.assets.references.length, 2)
  assert.equal(meta.assets.references[0].name, 'ref1.wav')
})

test('scanVoiceDir: 损坏的 meta.json 不炸', () => {
  const voiceId = 'testvoice6'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(voiceDir, { recursive: true })
  fs.writeFileSync(path.join(voiceDir, 'meta.json'), 'not valid json{')
  const meta = scanVoiceDir(voiceId, voiceDir)
  assert.equal(meta.id, voiceId)
  assert.ok(meta.assets)
})

//  listVoiceAssets / fullScan

test('listVoiceAssets: 空目录返回空对象', () => {
  clearAssets()
  const result = listVoiceAssets()
  assert.deepEqual(result, {})
})

test('listVoiceAssets: 扫描有 meta.json 的角色', () => {
  clearAssets()
  const voiceId = 'listed'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(voiceDir, { recursive: true })
  fs.writeFileSync(path.join(voiceDir, 'meta.json'), JSON.stringify({ id: voiceId, display_name: 'Listed' }))
  const result = listVoiceAssets()
  assert.ok(result[voiceId])
  assert.equal(result[voiceId].id, voiceId)
})

//  单个引擎的 scan.json 无法读取，只影响它自己扫到的引擎，不影响整个角色

test('listVoiceAssets: 声明无法读取的角色照常扫出模型，note 里点名出错的引擎', () => {
  clearAssets()
  layoutState.models = (voiceDir) => {
    const name = path.basename(voiceDir)
    if (name === 'brokenvoice') return { 'scan-eng-broken': { weights: [{ name: 'a.bin', path: '/nope' }] } }
    if (name === 'notjsonvoice') return { 'scan-eng-notjson': { weights: [{ name: 'a.bin', path: '/nope' }] } }
    return {}
  }
  for (const id of ['goodvoice', 'brokenvoice', 'notjsonvoice']) {
    fs.mkdirSync(path.join(tmpAssetsDir, id), { recursive: true })
  }
  const result = listVoiceAssets()
  assert.equal(result.goodvoice._scanError, undefined)
  assert.ok(result.goodvoice.assets, '好角色的 meta 该是完整的一份')
  for (const [id, eng, re] of [
    ['brokenvoice', 'scan-eng-broken', /langauge_from_name/],
    ['notjsonvoice', 'scan-eng-notjson', /不是合法 JSON/],
  ]) {
    assert.equal(result[id]._scanError, undefined, '单个引擎的声明无法读取不是整条扫描失败')
    assert.deepEqual(Object.keys(result[id].assets.models), [eng], '这个角色的模型清单要还在')
    const note = result[id].assets.scan_convention_notes
    assert.deepEqual(note.map(s => s.engine_id), [eng])
    assert.match(note[0].text, re)
  }
  layoutState.models = {}
})

test('⭐ listVoiceAssets: 同一角色里，一个引擎的声明无法读取不影响其他引擎的标签', () => {
  clearAssets()
  const dir = path.join(tmpAssetsDir, 'mixedvoice')
  fs.mkdirSync(dir, { recursive: true })
  const fp = path.join(dir, 'model-take12.bin')
  fs.writeFileSync(fp, Buffer.from('AB00'))
  layoutState.models = {
    'scan-eng-alpha': { weights: [{ name: 'model-take12.bin', path: fp }] },
    'scan-eng-broken': { weights: [{ name: 'b.bin', path: '/nope' }] },
  }
  const result = listVoiceAssets()
  const meta = result.mixedvoice
  assert.equal(meta._scanError, undefined)
  assert.equal(meta.assets.models['scan-eng-alpha'].weights[0].version, 'rev9')
  assert.deepEqual(meta.assets.scan_convention_notes.map(s => s.engine_id), ['scan-eng-broken'])
  layoutState.models = {}
})

// 一次扫描共用一个 run，唯一看得见的影响是这两个数：那份声明读了几次、缺它的日志打了几行。
// 不共用时扫出来的 meta 一个字都不变，所以只能这样钉。
function countConventionWork(scan) {
  const origWarn = console.warn
  const origRead = fs.readFileSync
  const warns = []
  let scanJsonReads = 0
  console.warn = (...a) => { warns.push(a.join(' ')) }
  fs.readFileSync = (...args) => {
    if (String(args[0]).endsWith('scan.json')) scanJsonReads += 1
    return origRead.apply(fs, args)
  }
  try {
    scan()
  } finally {
    console.warn = origWarn
    fs.readFileSync = origRead
  }
  return { scanJsonReads, warns: warns.filter(w => /scan-eng-plain/.test(w)) }
}

// 资产列表与全量扫描各自建一次 run：两条路都要单独钉，只钉一条时另一条不共用也照样绿。
// 这里走的是 /api/assets 那条：没有 meta.json 的角色才会现扫，已有 meta.json 的直接读它、不碰引擎目录。
test('⭐ listVoiceAssets: 一台引擎的约定读一次、报一行', () => {
  clearAssets()
  layoutState.models = { 'scan-eng-plain': { weights: [{ name: 'a.bin', path: '/nope' }] } }
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5']) {
    fs.mkdirSync(path.join(tmpAssetsDir, id), { recursive: true })
  }
  const work = countConventionWork(() => listVoiceAssets())
  assert.equal(work.scanJsonReads, 1, '五个角色共用同一台引擎：那份声明只该读一次')
  assert.equal(work.warns.length, 1, '日志里该引擎只出现一行')
  layoutState.models = {}
})

test('⭐ fullScan: 一台引擎的约定读一次、报一行', () => {
  clearAssets()
  layoutState.models = { 'scan-eng-plain': { weights: [{ name: 'a.bin', path: '/nope' }] } }
  for (const id of ['v1', 'v2', 'v3', 'v4', 'v5']) {
    fs.mkdirSync(path.join(tmpAssetsDir, id), { recursive: true })
  }
  const work = countConventionWork(() => fullScan())
  assert.equal(work.scanJsonReads, 1, '五个角色共用同一台引擎：那份声明只该读一次')
  assert.equal(work.warns.length, 1, '日志里该引擎只出现一行')
  layoutState.models = {}
})

test('fullScan: 声明无法读取的角色照常落盘 meta，其他角色不受影响', () => {
  clearAssets()
  layoutState.models = (voiceDir) =>
    path.basename(voiceDir) === 'brokenvoice'
      ? { 'scan-eng-broken': { weights: [{ name: 'a.bin', path: '/nope' }] } }
      : {}
  for (const id of ['goodvoice', 'brokenvoice']) {
    fs.mkdirSync(path.join(tmpAssetsDir, id), { recursive: true })
  }
  const result = fullScan()
  assert.equal(result.goodvoice._scanError, undefined)
  assert.ok(fs.existsSync(path.join(tmpAssetsDir, 'goodvoice', 'meta.json')))
  assert.equal(result.brokenvoice._scanError, undefined)
  assert.ok(fs.existsSync(path.join(tmpAssetsDir, 'brokenvoice', 'meta.json')),
    '模型扫出来了就该落盘')
  layoutState.models = {}
})

//  detectAssetState — 资产状态检测

test('detectAssetState: 空目录全 false', () => {
  const voiceId = 'empty'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(voiceDir, { recursive: true })
  const state = detectAssetState(voiceId)
  assert.equal(state.R, false)
  assert.equal(state.S, false)
  assert.equal(state.L, false)
  assert.equal(state.Seg, false)
  assert.equal(state.M, false)
})

test('detectAssetState: 有 raw 音频时 R=true', () => {
  const voiceId = 'hasraw'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(path.join(voiceDir, 'raw'), { recursive: true })
  put(voiceDir, 'raw/clip.wav', 'x')
  const state = detectAssetState(voiceId)
  assert.equal(state.R, true)
})

test('detectAssetState: 有 slicer_opt 时 S=true', () => {
  const voiceId = 'hasslices'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(path.join(voiceDir, 'slicer_opt'), { recursive: true })
  put(voiceDir, 'slicer_opt/seg.wav', 'x')
  const state = detectAssetState(voiceId)
  assert.equal(state.S, true)
})

test('detectAssetState: 有 segments.json 时 Seg=true', () => {
  const voiceId = 'hasseg'
  const voiceDir = path.join(tmpAssetsDir, voiceId)
  fs.mkdirSync(voiceDir, { recursive: true })
  fs.writeFileSync(path.join(voiceDir, 'segments.json'), JSON.stringify({ matched: 5 }))
  const state = detectAssetState(voiceId)
  assert.equal(state.Seg, true)
})
