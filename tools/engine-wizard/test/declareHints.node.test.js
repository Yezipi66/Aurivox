'use strict'
// 声明自动嗅探的守卫：词表只收形式明确的名字，拿不准的一律不猜。

const { test } = require('node:test')
const assert = require('node:assert')

const {
  normWord, audioRoleFor, formatHintsFrom, formatArgNameFrom, weightSlotHintsFrom,
} = require('../core/declareHints.js')

test('归一化：横线、驼峰、下划线写法归到同一个词', () => {
  assert.strictEqual(normWord('--emotion-audio'), 'emotion_audio')
  assert.strictEqual(normWord('emotionAudio'), 'emotion_audio')
  assert.strictEqual(normWord('--aux_ref_wavs'), 'aux_ref_wavs')
})

test('音频类输入认得情绪音频与辅助参考音频', () => {
  for (const n of ['emotion_audio', '--emotion-audio', 'aux_ref_audio', 'aux_reference_audio', 'style_ref_audio', 'secondary_wav']) {
    assert.strictEqual(audioRoleFor(n), 'audio_ref', n + ' 应认成音频类输入')
  }
})

test('主参考音频、情绪文本、情绪向量、权重开关都不标音频角色', () => {
  for (const n of ['ref_audio', 'voice', 'prompt_wav', 'speaker', 'emotion_text', 'emotion_vector', 'model_dir', 'text']) {
    assert.strictEqual(audioRoleFor(n), null, n + ' 不该被平台接管')
  }
})

test('输出格式只从 choices 推，没有 choices 不给建议', () => {
  const params = [
    { name: 'format', choices: ['wav', 'mp3', 'flac'] },
  ]
  assert.deepStrictEqual(formatHintsFrom(params), ['wav', 'mp3', 'flac'])
  assert.deepStrictEqual(formatHintsFrom([{ name: 'format' }]), [])
  assert.deepStrictEqual(formatHintsFrom([{ name: 'speed', choices: ['1', '2'] }]), [])
})

test('输出格式忽略 choices 里的无关值', () => {
  assert.deepStrictEqual(formatHintsFrom([{ name: 'output_format', choices: ['wav', 'long', 'short'] }]), ['wav'])
})

test('格式开关与允许值落在同一个参数上，没 choices 不给建议', () => {
  const params = [
    { name: 'speed' },
    { name: '--output-format', choices: ['wav', 'mp3'] },
  ]
  assert.strictEqual(formatArgNameFrom(params), 'output_format')
  assert.deepStrictEqual(formatHintsFrom(params), ['wav', 'mp3'])
  assert.strictEqual(formatArgNameFrom([{ name: 'format' }]), null,
    '没有 choices 时不能凭参数名认定这是格式开关')
  assert.strictEqual(formatArgNameFrom([{ name: 'format', choices: ['fast', 'slow'] }]), null,
    '值域里没有容器名就不是格式开关')
})

test('多权重位只在两个以上模型类开关时建议', () => {
  const params = [
    { source: 'cli', name: 'gpt_model' },
    { source: 'cli', name: 'vocoder_model' },
  ]
  const got = weightSlotHintsFrom(params)
  assert.deepStrictEqual(got.map((x) => x.name), ['gpt_model', 'vocoder_model'])
  assert.strictEqual(got[0].param, 'gpt_model')
  assert.strictEqual(got[0].applies_at, 'call')
})

test('单个模型开关或 {checkpoints} 那一格不升级成多权重位', () => {
  assert.deepStrictEqual(weightSlotHintsFrom([{ source: 'cli', name: 'model_dir' }]), [])
  assert.deepStrictEqual(weightSlotHintsFrom([
    { source: 'cli', name: 'model_dir' },
    { source: 'cli', name: 'text' },
  ]), [])
})

test('权重位嗅探只认 cli 来源，python 签名不参与', () => {
  assert.deepStrictEqual(weightSlotHintsFrom([
    { source: 'python', name: 'gpt_model' },
    { source: 'python', name: 'vocoder_model' },
  ]), [])
})

test('通用权重路径不升级成多权重位（真引擎嗅探暴露的误报）', () => {
  assert.deepStrictEqual(weightSlotHintsFrom([
    { source: 'cli', name: 'model_dir', source_file: 'a.py' },
    { source: 'cli', name: 'checkpoint_path', source_file: 'b.py' },
  ]), [])
})

test('两个角色型开关必须出自同一个文件才算一对', () => {
  assert.deepStrictEqual(weightSlotHintsFrom([
    { source: 'cli', name: 'gpt_model', source_file: 'a.py' },
    { source: 'cli', name: 'vocoder_model', source_file: 'b.py' },
  ]), [])
  assert.strictEqual(weightSlotHintsFrom([
    { source: 'cli', name: 'gpt_model', source_file: 'a.py' },
    { source: 'cli', name: 'vocoder_model', source_file: 'a.py' },
  ]).length, 2)
})
