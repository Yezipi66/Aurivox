'use strict'
// 第 3 步切页回来接上真实进度：前端要读 active 快照、恢复进度条、订阅 attach 流。
//   这里守三处接线。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const RUNNER = fs.readFileSync(path.join(EDITOR, 'downloadRunner.js'), 'utf8')
const STEP = fs.readFileSync(path.join(EDITOR, 'StepsExtra.jsx'), 'utf8')

test('下载执行器提供只订阅的 attach 流', () => {
  assert.match(RUNNER, /export function attachDownloadProgress \(id, onSnapshot, onFinish\)/)
  assert.match(RUNNER, /fetch\(`\/wizard\/download\/attach\?id=/)
  assert.match(RUNNER, /return \(\) => \{ stopped = true; ac\.abort\(\) \}/,
    '要能断开订阅，否则组件卸载后还在收事件')
})

test('第 3 步读 active 快照并恢复进度表', () => {
  const block = (STEP.match(/fetch\(`\/wizard\/download\/progress[\s\S]*?\n  \}, \[id\]\)/) || [''])[0]
  assert.ok(block, '少了读下载进度的 effect')
  assert.match(block, /const active = j\.active \|\| \{\}/)
  assert.match(block, /setDlFiles\(/)
  assert.match(block, /setDlBusyBoth\(true\)/)
})

test('恢复后订阅 attach 流持续更新', () => {
  assert.match(STEP, /attachDownloadProgress\(id, restore,/)
})
