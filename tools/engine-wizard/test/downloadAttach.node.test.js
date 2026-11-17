'use strict'
// 第 3 步切页回来要接上正在跑的下载：后端必须存进度快照并给新页面订阅端点。
//   这里守四处接线：注册表带 progress、两个文件流都写快照、progress 端点回 active、
//   attach 端点注册在 handleDownload 之前（否则被前缀吃掉）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const WB = fs.readFileSync(path.join(ROOT, 'tools', 'engine-wizard', 'core', 'wizardbridge.js'), 'utf8')
const VITE = fs.readFileSync(path.join(ROOT, 'web', 'wizard.vite.config.mjs'), 'utf8')

test('下载注册表带进度快照，并随取消信号一起生灭', () => {
  assert.match(WB, /entry = \{ ac: new AbortController\(\), count: 0, progress: \{\} \}/)
  assert.match(WB, /cur\.progress\[String\(name\)\] = \{ \.\.\.p, at: Date\.now\(\) \}/)
})

test('仓库文件流与直链流都写进度快照', () => {
  const notes = WB.match(/dl\.noteProgress\(/g) || []
  assert.ok(notes.length >= 2, '两个下载端点都要写快照，少一个就有一类文件恢复不了')
})

test('progress 端点返回在途快照 active', () => {
  const block = (WB.match(/function handleDownloadProgress[\s\S]*?\n\}/) || [''])[0]
  assert.match(block, /downloadAbortControllers\.get\(String\(id\)\)/)
  assert.match(block, /json\(res, 200, \{ ok: true, done, active \}\)/)
})

test('attach 端点存在，且注册在 handleDownload 之前', () => {
  assert.match(WB, /function handleDownloadAttach/)
  const atAttach = VITE.indexOf('handleDownloadAttach')
  const atDownload = VITE.indexOf('wb.handleDownload,')
  assert.ok(atAttach > 0 && atDownload > atAttach,
    'attach 是 /wizard/download 的子端点，必须排在 handleDownload 前缀匹配之前')
})
