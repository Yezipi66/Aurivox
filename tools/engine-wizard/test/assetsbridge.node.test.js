'use strict'
// 第 5 步右侧资产栏的数据源：向导直接读盘，不经过平台后端。
//   守卫钉住三件事：清单来自磁盘、切片按现存文件标记、试听由向导自己出字节；
//   任意一件退回平台端点，这一步就又被绑回 9886。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')

const {
  listVoices, listSegments, listRaw, resolveAssetFile, handleAssets,
} = require('../core/assetsbridge')

/** 1 秒 16bit 单声道 PCM：够 getWavDuration 读出时长。 */
function makeWav (rate = 8000, seconds = 1) {
  const data = Buffer.alloc(rate * seconds * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

function mkRoot () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-assets-'))
  const voice = path.join(root, 'VoiceA')
  fs.mkdirSync(path.join(voice, 'slicer_opt'), { recursive: true })
  fs.mkdirSync(path.join(voice, 'raw'), { recursive: true })
  fs.mkdirSync(path.join(voice, 'asr_opt'), { recursive: true })
  fs.writeFileSync(path.join(voice, 'slicer_opt', 'seg-1.wav'), makeWav())
  fs.writeFileSync(path.join(voice, 'raw', 'take1.wav'), makeWav())
  fs.writeFileSync(path.join(voice, 'raw', 'notes.txt'), 'not audio')
  fs.writeFileSync(path.join(voice, 'segments.json'), JSON.stringify({
    segments: [
      { audio_filename: 'seg-1.wav', text: '第一句', scene: '场景', index: 0, duration: 1 },
      { audio_path: 'D:\\elsewhere\\seg-2.wav', text: '文件已删' },
    ],
  }))
  fs.writeFileSync(path.join(voice, 'asr_opt', 'raw_opt.list'), 'take1.wav|spk|zh|原始转写\n')
  const voicesJson = path.join(root, 'voices.json')
  fs.writeFileSync(voicesJson, JSON.stringify({
    VoiceA: { display_name: '音色甲', language: 'zh' },
    VoiceB: {},
  }))
  // 键名与 lib/paths 一致：handleAssets 按这两个名字取落点。
  return { VOICES_JSON: voicesJson, ASSETS_ROOT: root }
}

test('listVoices：读注册表，缺字段按 id 与 unknown 兜底', () => {
  const { VOICES_JSON } = mkRoot()
  const voices = listVoices(VOICES_JSON)
  assert.strictEqual(voices.length, 2)
  assert.deepStrictEqual(voices.find((v) => v.id === 'VoiceA'),
    { id: 'VoiceA', display_name: '音色甲', language: 'zh' })
  assert.deepStrictEqual(voices.find((v) => v.id === 'VoiceB'),
    { id: 'VoiceB', display_name: 'VoiceB', language: 'unknown' })
})

test('listSegments：逐条核对磁盘，缺文件的切片 exists=false', () => {
  const { ASSETS_ROOT } = mkRoot()
  const data = listSegments(ASSETS_ROOT, 'VoiceA')
  assert.ok(data, '有 segments.json 却返回 null')
  assert.strictEqual(data.segments[0].exists, true)
  assert.strictEqual(data.segments[1].exists, false, '文件已删的切片不能标成可用')
  assert.strictEqual(data.live_matched, 1)
})

test('listSegments：没有 segments.json 返回 null（是没有，不是错误）', () => {
  const { ASSETS_ROOT } = mkRoot()
  assert.strictEqual(listSegments(ASSETS_ROOT, 'NoSuchVoice'), null)
})

test('listRaw：只列音频，转写按文件名从 raw_opt.list 取', () => {
  const { ASSETS_ROOT } = mkRoot()
  const raw = listRaw(ASSETS_ROOT, 'VoiceA')
  assert.strictEqual(raw.length, 1, '文本文件不该进音频清单')
  assert.strictEqual(raw[0].filename, 'take1.wav')
  assert.strictEqual(raw[0].text, '原始转写')
  assert.strictEqual(raw[0].duration, 1)
})

test('listRaw：没有 raw 目录返回空数组，不抛', () => {
  const { ASSETS_ROOT } = mkRoot()
  assert.deepStrictEqual(listRaw(ASSETS_ROOT, 'NoSuchVoice'), [])
})

test('resolveAssetFile：路径与扩展名三条判据都要过', () => {
  const { ASSETS_ROOT } = mkRoot()
  assert.ok(resolveAssetFile(ASSETS_ROOT, { voice: 'VoiceA', area: 'slicer_opt', name: 'seg-1.wav' }).file)
  assert.strictEqual(resolveAssetFile(ASSETS_ROOT, { voice: '../etc', area: 'raw', name: 'a.wav' }).code, 400)
  assert.strictEqual(resolveAssetFile(ASSETS_ROOT, { voice: 'VoiceA', area: 'models', name: 'a.wav' }).code, 400)
  assert.strictEqual(resolveAssetFile(ASSETS_ROOT, { voice: 'VoiceA', area: 'raw', name: '../a.wav' }).code, 400)
  assert.strictEqual(resolveAssetFile(ASSETS_ROOT, { voice: 'VoiceA', area: 'raw', name: 'notes.txt' }).code, 415)
  assert.strictEqual(resolveAssetFile(ASSETS_ROOT, { voice: 'VoiceA', area: 'raw', name: 'missing.wav' }).code, 404)
})

test('handleAssets：不接非 GET 与不认识的子路径', () => {
  const noop = { writeHead () {}, end () {} }
  assert.strictEqual(handleAssets({ url: '/wizard/assets/voices', method: 'POST' }, noop), false)
  assert.strictEqual(handleAssets({ url: '/wizard/assets/unknown', method: 'GET' }, noop), false)
  assert.strictEqual(handleAssets({ url: '/wizard/assets/voicesx', method: 'GET' }, noop), false)
})

// 端点层：起一个真 HTTP 服务器，四个端点各走一次，范围请求也验一遍。
function startServer (roots) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      try {
        if (!handleAssets(req, res, roots)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not handled' }))
        }
      } catch (e) {
        // 处理器自己该接住异常；这里再兜一层只为一件事：失败时也回响应，
        //   否则 fetch 会一直等下去，测试挂到超时。
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(e && e.message) }))
        } else {
          res.destroy()
        }
      }
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

test('端点：清单、切片、原始音频与试听字节都从磁盘来', async () => {
  const roots = mkRoot()
  const { server, base } = await startServer(roots)
  try {
    const voices = await (await fetch(`${base}/wizard/assets/voices`)).json()
    // 形状与 /api/voices 一致：body 顶层就是 voices，没有 data 包装。
    assert.strictEqual(voices.voices.length, 2)

    const segs = await (await fetch(`${base}/wizard/assets/segments?voice=VoiceA`)).json()
    assert.ok(segs.ok)
    assert.strictEqual(segs.segments.live_matched, 1)

    const raw = await (await fetch(`${base}/wizard/assets/raw-list?voice=VoiceA`)).json()
    assert.ok(raw.ok)
    assert.strictEqual(raw.raw[0].text, '原始转写')

    const fileRes = await fetch(`${base}/wizard/assets/file?voice=VoiceA&area=slicer_opt&name=seg-1.wav`)
    assert.strictEqual(fileRes.status, 200)
    assert.match(fileRes.headers.get('content-type'), /audio\/wav/)
    const bytes = Buffer.from(await fileRes.arrayBuffer())
    assert.strictEqual(bytes.length, makeWav().length)
    assert.strictEqual(bytes.subarray(0, 4).toString(), 'RIFF')

    const ranged = await fetch(`${base}/wizard/assets/file?voice=VoiceA&area=raw&name=take1.wav`,
      { headers: { range: 'bytes=0-3' } })
    assert.strictEqual(ranged.status, 206)
    assert.match(ranged.headers.get('content-range'), /^bytes 0-3\//)
    assert.strictEqual((await ranged.arrayBuffer()).byteLength, 4)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('端点：缺 voice、脏文件名、非音频扩展名都回 4xx', async () => {
  const roots = mkRoot()
  const { server, base } = await startServer(roots)
  try {
    assert.strictEqual((await fetch(`${base}/wizard/assets/segments`)).status, 400)
    assert.strictEqual((await fetch(`${base}/wizard/assets/segments?voice=${encodeURIComponent('../etc')}`)).status, 400)
    assert.strictEqual((await fetch(`${base}/wizard/assets/file?voice=VoiceA&area=raw&name=${encodeURIComponent('../a.wav')}`)).status, 400)
    assert.strictEqual((await fetch(`${base}/wizard/assets/file?voice=VoiceA&area=raw&name=notes.txt`)).status, 415)
    assert.strictEqual((await fetch(`${base}/wizard/assets/file?voice=VoiceA&area=raw&name=missing.wav`)).status, 404)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
