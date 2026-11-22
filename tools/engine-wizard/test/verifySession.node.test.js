'use strict'
// 第 5 步的会话段：使用者填的文本与视图开合按引擎存，切页重挂接回来。
//   校验结果、进度、资产列表是派生数据，不存、靠重取。
// 这里守三件事：白名单有这些字段、state 用存档做初值、预填只填空不覆盖。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const SESSION = fs.readFileSync(path.join(EDITOR, 'useInstallSession.js'), 'utf8')
const VERIFY = fs.readFileSync(path.join(EDITOR, 'StepVerify.jsx'), 'utf8')

test('会话段白名单含第 5 步的用户输入与视图开合', () => {
  for (const k of ['synthText', 'refAudio', 'refText', 'device',
    'checksOpen', 'overviewOpen', 'rightOpen', 'rightFull']) {
    assert.match(SESSION, new RegExp(k + ':'),
      '白名单缺 ' + k + '，切页重挂后这一项会丢')
  }
})

test('state 用存档做初值，不是写死默认', () => {
  assert.match(VERIFY, /useState\(saved\.synthText \|\| ''\)/)
  assert.match(VERIFY, /useState\(saved\.refAudio \|\| ''\)/)
  assert.match(VERIFY, /useState\(saved\.refText \|\| ''\)/)
  assert.match(VERIFY, /useState\(saved\.device \|\| \{ kind: 'auto' \}\)/)
  assert.match(VERIFY, /useState\(saved\.overviewOpen !== false\)/)
  assert.match(VERIFY, /useState\(saved\.rightOpen !== false\)/)
  assert.match(VERIFY, /useState\(saved\.rightFull === true\)/)
})

test('预填只填空的那几格，不覆盖存档里使用者填的值', () => {
  assert.match(VERIFY, /if \(!had\.synthText\) setSynthText\(/)
  assert.match(VERIFY, /if \(!had\.refAudio && !had\.refText\)/)
  assert.doesNotMatch(VERIFY,
    /if \(!id\) return undefined\s*\n\s*setSynthText\(/,
    '无条件 setSynthText 会把会话段里使用者填的值盖回默认')
})

test('写回会话段只包含用户输入与视图开合，不含派生数据', () => {
  const block = (VERIFY.match(/saveSession\(id, '', \{\s*\n\s*([\s\S]*?)\}\)/) || ['', ''])[1]
  for (const k of ['synthText', 'refAudio', 'refText', 'device',
    'checksOpen', 'overviewOpen', 'rightOpen', 'rightFull']) {
    assert.ok(block.includes(k), '写回漏了 ' + k)
  }
  for (const k of ['results', 'job', 'voices', 'assetSegs', 'progress']) {
    assert.ok(!block.includes(k), '派生数据 ' + k + ' 不该写进会话段')
  }
})
