'use strict'
// lib/server/assets.js：资产目录要真的读得到。
// 曾经从 lib/paths 解构了一个不存在的名字（ASSETS_DIR），拿到 undefined：
//   assetsNeedScan 恒为 false（启动时从不自动扫描），collectTakenVoiceIds 漏掉全部资产目录，而且都不报错。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-assets-'))
process.env.ASSETS_ROOT = ROOT

const { assetsNeedScan, collectTakenVoiceIds } = require('./assets')

test('有资产目录缺 meta.json / segments.json ⇒ assetsNeedScan 为真（启动时会自动扫描）', () => {
  fs.mkdirSync(path.join(ROOT, 'demo_voice', 'raw'), { recursive: true })
  assert.equal(assetsNeedScan(), true)
})

test('collectTakenVoiceIds 认得资产目录里的音色', () => {
  const r = collectTakenVoiceIds({ loadVoices: () => ({}), assetId: null, trainingPipeline: null })
  const ids = r instanceof Set ? [...r] : (r.taken ? [...r.taken] : Object.keys(r))
  assert.ok(ids.includes('demo_voice'), `没认出资产目录：${JSON.stringify(ids)}`)
})
