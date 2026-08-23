'use strict'

// ===========================================================================
//  上游失败报错：名字来自名片，承重来自属性
// ===========================================================================
// 契约 v2 第 3 步（甲）。这个文件钉两件事：
//   ① 出错时点的名 = 名片上的 label（接了别的引擎就说别的引擎）
//   ② 上游的状态码与正文以**属性**形式带出来，不必让下游去解析文案
// 第二条是重点：它是把「文案当机器接口」这个耦合拆掉的那一刀。

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { engineName, upstreamFailure, emptyAudioFailure } = require('./upstreamError')

const GSV = { id: 'gpt-sovits', label: 'GPT-SoVITS' }
const IDX = { id: 'indextts2', label: 'IndexTTS2' }

// --------------------------------------------------------------------------
//  ① 名字
// --------------------------------------------------------------------------

test('甲: 报错点的是这次真的发过去的那台引擎', () => {
  const err = upstreamFailure(IDX, 400, '{"detail":"unknown parameter: emo_alpha"}')
  assert.match(err.message, /^IndexTTS2 \/tts failed \(400\): /,
    '下游作者接了别的引擎，报错却说 GPT-SoVITS —— 会把他指向一台可能根本没启动的引擎')
  assert.doesNotMatch(err.message, /GPT-SoVITS/)
})

test('⭐ 甲: 老路径引擎这句话一个字节都没变（行为不变要有据可查）', () => {
  const err = upstreamFailure(GSV, 500, '{"detail":"CUDA out of memory"}')
  assert.equal(err.message,
    'GPT-SoVITS /tts failed (500): {"detail":"CUDA out of memory"}',
    '老路径引擎的 label 就是 GPT-SoVITS —— 今天在跑的用户不该看到任何变化')
})

test('甲: 流式那支是另一句话（它今天就长得不一样，别顺手统一了）', () => {
  const err = upstreamFailure(IDX, 502, 'boom', { streaming: true })
  assert.match(err.message, /^IndexTTS2 \/tts streaming failed \(502\): boom$/)
})

test('甲: 空音频也点名 —— 对调用方来说这和失败没区别', () => {
  assert.equal(emptyAudioFailure(IDX).message, 'IndexTTS2 returned empty audio')
  assert.equal(emptyAudioFailure(GSV).message, 'GPT-SoVITS returned empty audio')
})

test('甲: 名片没解析出来时也得能说人话，不能崩在报错路径上', () => {
  // 报错路径本身抛异常 = 真正的错误被吃掉，最难查的一类。
  assert.equal(engineName(null), 'TTS engine')
  assert.equal(engineName({}), 'TTS engine')
  assert.equal(engineName({ id: 'fishtts' }), 'fishtts', 'label 缺失时回落到 id')
  assert.equal(engineName({ label: '   ' }), 'TTS engine', '空白 label 不算名字')
  assert.match(upstreamFailure(null, 500, 'x').message, /^TTS engine \/tts failed \(500\): x$/)
})

// --------------------------------------------------------------------------
//  ② 承重：结构化字段
// --------------------------------------------------------------------------

test('⭐⭐ 甲: 上游状态码与正文挂在属性上，下游不必解析文案', () => {
  const err = upstreamFailure(IDX, 400, '{"detail":"bad"}')
  assert.equal(err.upstreamStatus, 400)
  assert.equal(err.upstreamBody, '{"detail":"bad"}')
  assert.equal(err.engineId, 'indextts2')
  assert.equal(err.engineLabel, 'IndexTTS2')
})

test('甲: 正文是 Buffer 也收（运输层给的就是 Buffer）', () => {
  const err = upstreamFailure(GSV, 500, Buffer.from('{"detail":"oom"}'))
  assert.equal(err.upstreamBody, '{"detail":"oom"}')
  assert.match(err.message, /\{"detail":"oom"\}$/)
})

test('甲: 正文为空时 upstreamBody 是空串，不是 undefined/"null"', () => {
  for (const empty of [undefined, null, '']) {
    const err = upstreamFailure(GSV, 500, empty)
    assert.equal(err.upstreamBody, '', `正文 ${String(empty)} 被写成了 ${JSON.stringify(err.upstreamBody)}`)
  }
})

test('甲: 空音频那条没有 upstreamBody —— 它压根没有上游正文可言', () => {
  const err = emptyAudioFailure(GSV)
  assert.equal(err.upstreamBody, undefined,
    '给它编一个空正文，会让下游误以为上游说了什么')
  assert.equal(err.engineId, 'gpt-sovits')
})

test('甲: 抛出来的是真 Error（instanceof / stack 都要在）', () => {
  const err = upstreamFailure(GSV, 500, 'x')
  assert.ok(err instanceof Error)
  assert.equal(typeof err.stack, 'string')
})

// --------------------------------------------------------------------------
//  ③ 调用点都接上了没有
// --------------------------------------------------------------------------
//
// ⚠⚠ 这是一条**弱守卫**，我不假装它不是：它只扫文本、只认这几个字面量，
//    换成双引号拼接、或者把引擎名拆成变量再拼，都能绕过去。
//
//    它存在的唯一理由是 server.js 没有别的办法测：那个文件一被 require 就
//    app.listen（server.js:1899），进不了测试进程。routes 那一侧有真正的
//    行为测试（synthesis.errorEngineName.node.test.js），server.js 这一侧
//    的真凭实据只能靠真机 —— 拿一台故意回 400 的回声引擎跑一遍。
//    别把这条守卫当成那份证据。

const fs = require('node:fs')
const path = require('node:path')

const HARDCODED = ['GPT-SoVITS /tts failed', 'GPT-SoVITS /tts streaming failed', 'GPT-SoVITS returned empty audio']

// 注释里出现旧文案是允许的（那是在解释历史），只看代码行。
function codeLines (file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
}

test('甲: server.js 的老合成路径不再写死引擎名（⚠ 弱守卫，见上方说明）', () => {
  const lines = codeLines(path.join(__dirname, '..', '..', 'server.js'))
  for (const bad of HARDCODED) {
    assert.ok(!lines.some((l) => l.includes(bad)), `server.js 代码里还留着写死的「${bad}」`)
  }
  assert.ok(lines.some((l) => l.includes('upstreamError')),
    'server.js 压根没接上 upstreamError —— 上面那条"没有旧文案"可能只是因为它换了个写法')
})
