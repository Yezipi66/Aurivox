'use strict'
// 预填端点 /wizard/verify/ref 与 lib/server/refAudio 的 firstRefAudio：
//   第 5 步代填的参考素材必须与合成主链路同一个取法，两条线各自读盘
//   就会出现两种「参考音频」，一边改了另一边不知道。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { firstRefAudio } = require('../../../lib/server/refAudio')

function mkAssets (segments) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-refaudio-'))
  const voiceDir = path.join(root, 'some-engine')
  fs.mkdirSync(voiceDir)
  fs.writeFileSync(path.join(voiceDir, 'segments.json'), JSON.stringify({ segments }))
  return root
}

test('第一条 matched 切片取出来，参考文本一起带', () => {
  const root = mkAssets([
    { matched: true, audio: 'seg-01.wav', text: '你好' },
  ])
  const r = firstRefAudio('some-engine', { assetsRoot: root })
  assert.ok(r, '有 matched 切片却返回 null')
  assert.ok(r.reference_audio.includes('seg-01.wav'), r.reference_audio)
  assert.strictEqual(r.reference_text, '你好')
})

test('三种路径键名都认：audio / audio_path / audio_filename', () => {
  for (const key of ['audio', 'audio_path', 'audio_filename']) {
    const root = mkAssets([{ matched: true, [key]: 'a.wav', text: 'x' }])
    assert.ok(firstRefAudio('some-engine', { assetsRoot: root }),
      `切片用 ${key} 键名时取不出来`)
  }
})

test('matched=false 的切片不算可用素材', () => {
  const root = mkAssets([{ matched: false, audio: 'x.wav' }])
  assert.strictEqual(firstRefAudio('some-engine', { assetsRoot: root }), null)
})

test('没有 segments.json 或目录不存在时返回 null，不抛（不是错误，是没有）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-refaudio-'))
  assert.strictEqual(firstRefAudio('some-engine', { assetsRoot: root }), null)
  assert.strictEqual(firstRefAudio('no-such-voice', { assetsRoot: root }), null)
  assert.strictEqual(firstRefAudio('', { assetsRoot: root }), null,
    '空 id 不该去找素材')
})

// 端点层：接进来的请求要挡非法 id；素材由 firstRefAudio 给，这里只验接线。
test('handleVerifyRef：缺 id 与脏 id 挡掉，合法 id 一定回 200 与字符串字段', async () => {
  const { handleVerifyRef } = require('../core/wizardbridge')
  const call = (url) => new Promise((resolve) => {
    const res = {
      code: null,
      writeHead (c) { this.code = c },
      end (b) { resolve({ code: this.code, json: JSON.parse(b) }) },
    }
    handleVerifyRef({ url, method: 'GET' }, res)
  })
  const noId = await call('/wizard/verify/ref')
  assert.strictEqual(noId.code, 400)
  const bad = await call('/wizard/verify/ref?id=' + encodeURIComponent('../etc'))
  assert.strictEqual(bad.code, 400)
  const ok = await call('/wizard/verify/ref?id=some-engine')
  assert.strictEqual(ok.code, 200)
  assert.ok(ok.json.ok)
  assert.strictEqual(typeof ok.json.reference_audio, 'string')
  assert.strictEqual(typeof ok.json.reference_text, 'string')
})

test('handleVerifyRef：POST 与带尾巴的路径不接管', () => {
  const { handleVerifyRef } = require('../core/wizardbridge')
  const noop = { writeHead () {}, end () {} }
  assert.strictEqual(
    handleVerifyRef({ url: '/wizard/verify/ref', method: 'POST' }, noop), false)
  assert.strictEqual(
    handleVerifyRef({ url: '/wizard/verify/ref/xx', method: 'GET' }, noop), false)
})
