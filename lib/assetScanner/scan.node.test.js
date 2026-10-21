'use strict'

//  scan.js — 资产扫描逻辑
// 用 require.cache 注入 mock 依赖，用 tmpdir 构造测试目录。
// 不依赖真实 engines/ 或 cache/ 目录。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

// ---- 用 require.cache 注入 mock 依赖 ----------------------------------------

const tmpAssetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'))

// 解析 scan.js 依赖的真实路径
const constsPath = require.resolve('./consts')
const modelLayoutPath = require.resolve('../assets/modelLayout')
const pipelineIdentityPath = require.resolve('../training/pipelineIdentity')
const audioDurationPath = require.resolve('./audioDuration')
const transcriptPath = require.resolve('./transcript')

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
    enginesWithModels: () => [],
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
    extractStep: (name) => {
      const m = name.match(/e(\d+)/)
      return m ? parseInt(m[1], 10) : null
    },
    inspectTranscriptList: () => ({ status: 'none' }),
    buildSegmentsFor: () => null,
    generateSegments: () => ({ matched: 0 }),
  },
}

const {
  listVoiceAssets,
  deriveLanguageFromModels,
  detectSovitsVersion,
  annotateLegacyGsvLabels,
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

//  detectSovitsVersion — 版本头解析

test('detectSovitsVersion: 识别 v1 版本头', () => {
  const dir = tmpdir('ver1')
  const fp = put(dir, 'model.pth', Buffer.from([0x30, 0x30, 0x00, 0x00]))
  assert.equal(detectSovitsVersion(fp), 'v1')
})

test('detectSovitsVersion: 识别 v2 版本头', () => {
  const dir = tmpdir('ver2')
  const fp = put(dir, 'model.pth', Buffer.from([0x30, 0x31, 0x00, 0x00]))
  assert.equal(detectSovitsVersion(fp), 'v2')
})

test('detectSovitsVersion: 识别 v2Pro 版本头', () => {
  const dir = tmpdir('ver2pro')
  const fp = put(dir, 'model.pth', Buffer.from([0x30, 0x35, 0x00, 0x00]))
  assert.equal(detectSovitsVersion(fp), 'v2Pro')
})

test('detectSovitsVersion: 从文件名恢复版本', () => {
  const dir = tmpdir('fname')
  const fp = put(dir, 'model_v2Pro_e10_s100.pth', Buffer.alloc(1024))
  assert.equal(detectSovitsVersion(fp), 'v2Pro')
})

test('detectSovitsVersion: 文件不存在返回 null', () => {
  assert.equal(detectSovitsVersion('/nonexistent/file.pth'), null)
})

//  annotateLegacyGsvLabels — 纯函数

test('annotateLegacyGsvLabels: 标注 steps 和 version', () => {
  const models = {
    'mock-engine': {
      gpt: [{ name: 'model_e10.ckpt', path: '/a.ckpt' }],
      sovits: [{ name: 'model_e10_s100.pth', path: '/b.pth' }],
    },
  }
  annotateLegacyGsvLabels(models)
  assert.equal(models['mock-engine'].gpt[0].steps, 10)
  assert.equal(models['mock-engine'].sovits[0].steps, 10)
  // version 由 detectSovitsVersion 读取文件，mock 环境下返回 null
  assert.equal(models['mock-engine'].sovits[0].version, null)
})

test('annotateLegacyGsvLabels: 空输入不炸', () => {
  assert.doesNotThrow(() => annotateLegacyGsvLabels(null))
  assert.doesNotThrow(() => annotateLegacyGsvLabels({}))
})

//  deriveLanguageFromModels — 语言推导

test('deriveLanguageFromModels: 从文件名推导语言', () => {
  const dir = tmpdir('lang')
  // 构造模型目录结构
  put(dir, 'models/mock-engine/gpt/model_ja-e10.ckpt', 'x')
  // 由于 mock 了 enginesWithModels 返回 []，这个测试验证无模型时返回 null
  // 实际 deriveLanguageFromModels 内部调用 enginesWithModels
  const result = deriveLanguageFromModels(dir)
  assert.equal(result, null) // mock 下 enginesWithModels 返回空数组
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
