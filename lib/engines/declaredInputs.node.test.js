'use strict'
// 平台声明输入的守卫：不声明就没有能力；声明了才透传，且只透传声明过的名字。

const { test } = require('node:test')
const assert = require('node:assert')

const {
  declaredInputs, audioInputs, resolveAudioArgs,
} = require('./declaredInputs.js')

const CALL = {
  args: {
    device: { flag: '--device', style: 'value', role: 'device', device_format: 'torch' },
    emotion_audio: {
      flag: '--emotion-audio', style: 'value', role: 'audio_ref',
      label: '情绪参考音频', label_en: 'Emotion reference',
    },
    aux_wavs: { flag: '--aux-wav', style: 'repeat', role: 'audio_ref', label: '辅助参考音频' },
    speed: { flag: '--speed', style: 'value' },
  },
}

test('没声明 role 的参数不进清单：平台不替人猜', () => {
  const all = declaredInputs(CALL).map((x) => x.name)
  assert.ok(!all.includes('speed'), '普通参数不是平台声明的输入')
})

test('设备与音频分属两路，音频清单里没有设备', () => {
  assert.deepStrictEqual(audioInputs(CALL).map((x) => x.name), ['emotion_audio', 'aux_wavs'])
  assert.deepStrictEqual(declaredInputs({ args: {} }), [])
})

test('标签与单值/多值形状都来自名片，平台不写死', () => {
  const [emo, aux] = audioInputs(CALL)
  assert.strictEqual(emo.label, '情绪参考音频')
  assert.strictEqual(emo.labelEn, 'Emotion reference')
  assert.strictEqual(emo.flag, '--emotion-audio')
  assert.strictEqual(emo.multiple, false)
  assert.strictEqual(aux.multiple, true, 'repeat 是多选')
})

test('没声明就完全没有控件：空名片不产生任何输入', () => {
  assert.deepStrictEqual(declaredInputs(null), [])
  assert.deepStrictEqual(declaredInputs({}), [])
  assert.deepStrictEqual(resolveAudioArgs({}, { emotion_audio: ['a.wav'] }), {})
})

test('透传只认声明过的名字，单选发字符串、多选发数组', () => {
  const got = resolveAudioArgs(CALL, {
    emotion_audio: ['/a.wav', '/b.wav'],
    aux_wavs: ['/x.wav', '/y.wav'],
    speed: '2',
  })
  assert.strictEqual(got.emotion_audio, '/a.wav', '单选只取第一个')
  assert.deepStrictEqual(got.aux_wavs, ['/x.wav', '/y.wav'])
  assert.strictEqual(got.speed, undefined, '没声明的键不进请求')
})

test('空值不下发：留空等于这次不用这个能力', () => {
  const got = resolveAudioArgs(CALL, { emotion_audio: [], aux_wavs: [''], device: 'cuda' })
  assert.deepStrictEqual(got, {})
})

test('多选声明也收单个字符串，界面不必为了一格造两种形状', () => {
  const got = resolveAudioArgs(CALL, { aux_wavs: '/one.wav' })
  assert.deepStrictEqual(got.aux_wavs, ['/one.wav'])
})
