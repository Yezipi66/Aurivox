import test from 'node:test'
import assert from 'node:assert/strict'
import { readDirSources } from '../../__testsupport__/readDirSources.mjs'

// 读本目录下全部源码：组件按功能拆成多个文件后，只读 GenerateTab.jsx
// 会看不见拆出去的部分，守卫静默失效。
const src = readDirSources(import.meta.url, '.')

test('Generate 只拒绝真正的空字符串，发送 text 原文', () => {
  assert.match(src, /if \(text === ''\)/)
  assert.match(src, /voice: selectedVoice, text, format: 'wav'/)
  assert.doesNotMatch(src, /text:\s*text\.trim\(\)/)
  assert.doesNotMatch(src, /if \(!text\.trim\(\)\)/)
})

test('字符计数与分段估算不偷偷裁掉空白', () => {
  assert.match(src, /const t = typeof body\.text === 'string' \? body\.text : ''/)
  assert.doesNotMatch(src, /text\.trim\(\)\.length/)
})

test('即时合成与配方保存都调用 paramsToSend，不全量复制 paramValues', () => {
  assert.match(src, /const explicitEngineParams = paramsToSend\(engine, paramValues, touchedParams\)/)
  assert.match(src, /engine_params: engine\?\.id[\s\S]{0,180}paramsToSend\(engine, paramValues, touchedParams\)/)
  assert.doesNotMatch(src, /\[engine\.id\]: \{ \.\.\.paramValues \}/)
})
