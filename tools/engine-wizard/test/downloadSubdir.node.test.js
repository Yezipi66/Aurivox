'use strict'
// 下载位置非法时，端点要明确拒绝，不能清空后悄悄落到权重根。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { subdirIsSafe } = require('../core/download')
const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'wizardbridge.js'), 'utf8')

test('权重目录内的相对路径可用', () => {
  for (const v of ['', 'sub', 'a/b', './sub', 'checkpoints/s2-pro', 'a\\b']) {
    assert.strictEqual(subdirIsSafe(v), true, v)
  }
})

test('越界与绝对下载位置不可用', () => {
  for (const v of ['../x', 'a/../b', '..', 'D:/models', 'C:\\models', '/abs', '\\abs']) {
    assert.strictEqual(subdirIsSafe(v), false, v)
  }
})

test('四个下载端点都先校验下载位置', () => {
  const guards = SRC.match(/rejectBadSubdir\(res, subdir\)/g) || []
  assert.strictEqual(guards.length, 4, '列文件、仓库文件下载、直链下载、删除半截文件都要校验')
  assert.match(SRC, /code: 'BAD_SUBDIR'/, '拒绝时给出明确的错误码')
})
