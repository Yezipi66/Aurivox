'use strict'
// 第 2 步装完依赖要重拉完成状态：后端已写 .wizard-install.json，
//   不重拉 install-state，流程条第 2 步的绿勾要等别的操作才亮。
// 这里守安装结束后确实调了 onReload，且成功失败两条路都调。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'editor', 'StepDeps.jsx'), 'utf8')

test('安装流结束后重拉完成状态', () => {
  const block = (SRC.match(
    /setResult\(done\)[\s\S]*?if \(onReload\) onReload\(\)[\s\S]*?\n    \} catch \(e\)/) || [''])[0]
  assert.ok(block, 'setResult(done) 之后必须调 onReload 重拉 install-state')
})

test('失败也重拉：envFailure 写进去了，界面要如实显示未就绪', () => {
  const block = (SRC.match(
    /\} catch \(e\) \{\s*\n\s*setResult\(\{ ok: false, error: e\.message \}\)\s*\n\s*if \(onReload\) onReload\(\)/) || [''])[0]
  assert.ok(block, 'catch 分支也要调 onReload')
})
