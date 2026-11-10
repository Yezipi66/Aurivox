'use strict'
// 直链端点的两条写入纪律：同名文件默认保留、重新下载才覆盖，
//   以及续传要开启 .tmp 检测（否则中断后只能从头再下）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'wizardbridge.js'), 'utf8')

function handlerBody () {
  const at = SRC.indexOf('function handleDownloadUrl')
  assert.ok(at > 0, '找不到 handleDownloadUrl')
  const end = SRC.indexOf('// /wizard/hf-token', at)
  return SRC.slice(at, end > 0 ? end : at + 6000)
}

test('直链已有同名文件时保留，只有 overwrite 才覆盖', () => {
  const body = handlerBody()
  assert.match(body, /KEPT_EXISTING/, '缺少保留分支')
  assert.match(body, /!overwrite/, '保留分支要受 overwrite 控制')
  assert.match(body, /if \(overwrite\)[\s\S]{0,120}rmSync\(finalPath/, '覆盖前要删掉旧文件')
})

test('直链开启 .tmp 检测，中断后能续传', () => {
  const body = handlerBody()
  assert.match(body, /downloadFileFromUrl\(raw, file, '', root, id, onLine, onProgress, 0, false,/,
    'skipTmpDetect 必须是 false，否则中断后从头再下')
})
