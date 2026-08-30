import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SELECT_SOURCES, basenameOf, voiceOptions, weightOptions, audioOptions, optionsForField
} from './selectSources.pure.js'

// ---------------------------------------------------------------------------
//  select + source 的候选表
// ---------------------------------------------------------------------------

test('平台只认三个库，而且和后端是同一张表', () => {
  // ⛔ 两边分叉的症状：名片写 source:"audio"，后端收得下、前端递不出候选 ——
  //   格子照样画，只是永远空的，不报错。
  assert.deepEqual(SELECT_SOURCES, ['voices', 'weights', 'audio'])
})

test('⭐ 名片写了一个平台不认识的库名 ⇒ fail-open：格子照画，候选是空的', () => {
  // ⛔ 不是不画。少一格找不到、还没有报错，比多一格坏得多；
  //   而且 allow_custom 的格子本来就能直接打字，候选空着也填得出东西。
  const f = { name: 'x', type: 'select', source: 'no-such-library' }
  assert.deepEqual(optionsForField(f, { audio: [{ value: 'a' }] }), [])
})

test('不是 select + source 的格子返回 null（跟「空候选」不是一回事）', () => {
  assert.equal(optionsForField({ name: 'x', type: 'select', choices: ['a'] }, {}), null)
  assert.equal(optionsForField({ name: 'x', type: 'file' }, {}), null)
  assert.equal(optionsForField(null, {}), null)
})

test('取候选：三个库各自的形状', () => {
  const sources = {
    voices: voiceOptions([{ id: 'ayaka', display_name: '绫华' }, { id: 'bare' }, null]),
    weights: weightOptions(['D:\\m\\a.ckpt', 'D:\\m\\a.ckpt', '/m/b.pth', '']),
    audio: audioOptions(
      [{ audio: '/a/1.wav' }, { audio: '/a/gone.wav', exists: false }, { audio_path: '/a/2.wav' }],
      ['/a/1.wav', { path: '/a/3.wav' }]
    ),
  }
  assert.deepEqual(optionsForField({ source: 'voices' }, sources), [
    { value: 'ayaka', label: '绫华' },
    { value: 'bare', label: 'bare' },
  ])
  // ⚠ 去重：同一个权重在资产和 checkpoints 里各出现一次是常事
  assert.deepEqual(optionsForField({ source: 'weights' }, sources), [
    { value: 'D:\\m\\a.ckpt', label: 'a.ckpt' },
    { value: '/m/b.pth', label: 'b.pth' },
  ])
  // ⚠ 弄丢的切片不进候选；⚠ 切片和原始里重复的那个只出现一次
  assert.deepEqual(optionsForField({ source: 'audio' }, sources), [
    { value: '/a/1.wav', label: '1.wav' },
    { value: '/a/2.wav', label: '2.wav' },
    { value: '/a/3.wav', label: '3.wav' },
  ])
})

test('basenameOf 两种分隔符都认（配方里存的是 Windows 路径）', () => {
  assert.equal(basenameOf('D:\\models\\x\\a.ckpt'), 'a.ckpt')
  assert.equal(basenameOf('/home/x/a.wav'), 'a.wav')
  assert.equal(basenameOf('a.wav'), 'a.wav')
  assert.equal(basenameOf(null), '')
})
