'use strict'
// setup.py 作为依赖清单来源的解析测试。
//
// 为什么要有这一条：不少上游（piper 就是）只把依赖写在 setup.py 的
//   install_requires 里，pyproject.toml 里只有 [build-system]。漏掉这个来源
//   会报「读不到依赖清单」，而使用者打开文件一看 pyproject.toml 明明在。
// 判据两条：读得到 install_requires，且不执行 setup.py（它是任意 Python，
//   执行它等于在装引擎之前先运行上游代码）。

const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { parseSetupInstallRequires } =
  require(path.join(__dirname, '..', 'core', 'wizardbridge.js'))

test('读得到 install_requires 里的每一条', () => {
  const src = 'setup(\n  name="piper",\n'
    + '  install_requires=[\n    "onnxruntime>=1,<2",\n    "pathvalidate>=3,<4",\n  ],\n)'
  assert.deepEqual(parseSetupInstallRequires(src),
    ['onnxruntime>=1,<2', 'pathvalidate>=3,<4'])
})

test('extras_require 不算依赖清单（那是可选附加，不是安装必备）', () => {
  const src = 'setup(\n  install_requires=["onnxruntime>=1,<2"],\n'
    + '  extras_require={"train": ["torch>=2,<3", "lightning>=2,<3"]},\n)'
  const got = parseSetupInstallRequires(src)
  assert.deepEqual(got, ['onnxruntime>=1,<2'])
  assert.ok(!got.some((s) => s.includes('torch')),
    'extras_require 里的 torch 被当成必备依赖了')
})

test('没有 install_requires ⇒ 空数组（不是 null，调用方可以直接取 length）', () => {
  assert.deepEqual(parseSetupInstallRequires('setup(name="x")'), [])
  assert.deepEqual(parseSetupInstallRequires(''), [])
  assert.deepEqual(parseSetupInstallRequires(null), [])
})

test('不执行 setup.py：带副作用的写法也只当文本读', () => {
  // 真的 exec 起来下面这句会有副作用；这里只该有解析结果。
  const src = 'import os\nos.system("echo hi")\n'
    + 'setup(install_requires=["onnxruntime>=1,<2"])'
  assert.deepEqual(parseSetupInstallRequires(src), ['onnxruntime>=1,<2'])
})
