import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('./GenerateTab.jsx', import.meta.url), 'utf8')

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
