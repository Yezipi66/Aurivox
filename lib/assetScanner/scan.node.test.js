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

// 解析 scan.js 依赖的真实路径
const constsPath = require.resolve('./consts')
const modelLayoutPath = require.resolve('../assets/modelLayout')
const pipelineIdentityPath = require.resolve('../training/pipelineIdentity')
const audioDurationPath = require.resolve('./audioDuration')
const transcriptPath = require.resolve('./transcript')

const layoutState = { engines: [] }

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
    scanVoiceModels: () => ({}),
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

test('annotateModelLabels: 没有 scan.json 的引擎不贴标签，也不炸', () => {
  const models = { 'scan-eng-plain': { weights: [{ name: 'model-take12.bin', path: '/nope' }] } }
  assert.doesNotThrow(() => annotateModelLabels(models))
  assert.equal(models['scan-eng-plain'].weights[0].steps, undefined)
  assert.equal(models['scan-eng-plain'].weights[0].version, undefined)
})

test('annotateModelLabels: 空输入不炸', () => {
  assert.doesNotThrow(() => annotateModelLabels(null))
  assert.doesNotThrow(() => annotateModelLabels({}))
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
