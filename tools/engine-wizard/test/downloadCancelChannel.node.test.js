'use strict'
// 第 3 步的「停止」要停掉整轮下载。仓库文件与文件直链必须共用同一条取消通道，
// 否则直链会继续把文件写完，界面却已经显示已取消。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'wizardbridge.js'), 'utf8')

function bodyOf (name) {
  const at = SRC.indexOf('function ' + name + ' (')
  assert.ok(at > 0, '找不到 ' + name)
  return SRC.slice(at, SRC.indexOf('\nfunction ', at + 10))
}

test('两个下载端点都登记到共享取消通道', () => {
  for (const name of ['handleDownloadFile', 'handleDownloadUrl']) {
    const body = bodyOf(name)
    assert.match(body, /acquireDownloadAbort\(id\)/, name + ' 要登记取消通道')
    assert.match(body, /dl\.signal/, name + ' 要把共享信号交给下载器')
    assert.match(body, /dl\.release\(\)/, name + ' 结束时要释放引用')
  }
})

test('早退分支也要释放，否则取消通道会挂着一个没有在途请求的控制器', () => {
  const body = bodyOf('handleDownloadUrl')
  const kept = body.indexOf('KEPT_EXISTING')
  assert.ok(kept > 0)
  assert.match(body.slice(kept, kept + 500), /dl\.release\(\)/)
})

test('整轮取消只 abort 共享控制器，单个请求断开只 abort 自己', () => {
  assert.match(bodyOf('handleDownloadCancel'), /entry\.ac\.abort\(\)/)
  assert.match(bodyOf('acquireDownloadAbort'), /const local = new AbortController\(\)/)
  assert.match(bodyOf('handleDownloadUrl'), /dl\.abort\(\)/)
})
