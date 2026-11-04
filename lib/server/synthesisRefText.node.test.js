'use strict'
// resolveReference 的优先级测试：请求里手工填的参考文本不许被自动取来的切片文本覆盖。
// 现有服务层测试都把 resolveReference 换成了替身，这份实现的优先级此前没有测试兜着。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const REF_AUDIO = path.join(__dirname, 'refAudio.js')
const SYNTHESIS = path.join(__dirname, 'synthesis.js')

/** 用给定的切片结果顶掉 refAudio 模块，返回还原函数。 */
function stubFirstRefAudio (seg) {
  require.cache[REF_AUDIO] = {
    id: REF_AUDIO,
    filename: REF_AUDIO,
    loaded: true,
    exports: { firstRefAudio: () => seg },
  }
  delete require.cache[SYNTHESIS]
  return () => {
    delete require.cache[REF_AUDIO]
    delete require.cache[SYNTHESIS]
  }
}

function resolveWith (cfg, seg) {
  const restore = stubFirstRefAudio(seg)
  try {
    const { createSynthesisModule } = require(SYNTHESIS)
    return createSynthesisModule({}).resolveReference(cfg)
  } finally {
    restore()
  }
}

const SEG = { reference_audio: 'D:\\ref\\seg.wav', reference_text: '切片里的文本' }

test('请求带参考文本时，自动取切片不覆盖手工值', () => {
  const got = resolveWith({ reference_text: '手工填的' }, SEG)
  assert.strictEqual(got.reference_text, '手工填的',
    '切片文本只是缺省来源，手工值被覆盖等于填了也没有效果')
  assert.strictEqual(got.reference_audio, 'D:\\ref\\seg.wav')
})

test('请求没带参考文本时，回落到切片里的文本', () => {
  const got = resolveWith({}, SEG)
  assert.strictEqual(got.reference_text, '切片里的文本')
})

test('请求带了参考音频时不走自动取片，参考文本按请求来', () => {
  const got = resolveWith({ reference_audio: 'D:\\ref\\a.wav', reference_text: '手工填的' }, SEG)
  assert.strictEqual(got.reference_audio, 'D:\\ref\\a.wav')
  assert.strictEqual(got.reference_text, '手工填的')
})

test('没有切片也没有请求值时，两项都为空', () => {
  const got = resolveWith({ reference_text: '手工填的' }, null)
  assert.strictEqual(got.reference_audio, '')
  assert.strictEqual(got.reference_text, '手工填的')
})
