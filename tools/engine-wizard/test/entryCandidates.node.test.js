'use strict'
// 入口候选清单的边界：文件发现只列 .py，不设目录层级上限；
// 明确与入口无关的目录与文件从清单里剔除，其余按证据强度排序，不按文件名猜。
//
// 覆盖三件事：深目录里的入口不会消失；非 Python 文件与依赖目录不进清单；
// 每个候选项都带上写进 call.argv 需要的模块名与起算目录。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { findPyFiles, isNotEntryFile } = require('../core/pyFiles')
const { buildEntryCandidates } = require('../core/entryCandidates')

function makeTree () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-entry-'))
  const write = (rel, body = '') => {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body, 'utf8')
  }
  return { root, write }
}

const four = (file) => [
  { name: 'text', source_file: file, group: '(root)', required: true },
  { name: 'ref_audio', source_file: file, group: '(root)', required: false },
  { name: 'output_path', source_file: file, group: '(root)', required: false },
  { name: 'model', source_file: file, group: '(root)', required: false },
]

test('只列 .py，且六层深的目录照样找得到', () => {
  const { root, write } = makeTree()
  try {
    write('a/b/c/d/e/f/infer_cli.py', 'import argparse\n')
    write('run.sh', 'python -m x\n')
    write('weights.bin', 'x')
    write('README.md', '# demo')
    const got = findPyFiles(root)
    assert.deepStrictEqual(got, ['a/b/c/d/e/f/infer_cli.py'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('安装脚本、包初始化、测试、依赖目录与文档目录不进清单', () => {
  const { root, write } = makeTree()
  try {
    write('setup.py', '')
    write('pkg/__init__.py', '')
    write('tests/test_x.py', '')
    write('pkg/x_test.py', '')
    write('.venv/lib/fake.py', '')
    write('docs/example.py', '')
    write('pkg/infer.py', '')
    assert.deepStrictEqual(findPyFiles(root), ['pkg/infer.py'])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('网页界面与启动包装不属于入口，但输入框仍允许直接输入它们', () => {
  for (const n of ['webui.py', 'app.py', 'gradio_app.py', 'launch.py', 'demo.py']) {
    assert.strictEqual(isNotEntryFile(n), true, `${n} 该从下拉候选中剔除`)
  }
  for (const n of ['infer.py', 'cli.py', 'webui_cli.py', 'tts_app.py']) {
    assert.strictEqual(isNotEntryFile(n), false, `${n} 不该被一并剔除`)
  }
})

test('候选带模块名与 src 起算目录，推荐项排在最前', () => {
  const { root, write } = makeTree()
  try {
    write('src/a/b/c/infer_cli.py', '')
    write('src/a/b/other.py', '')
    write('webui.py', '')
    const params = [
      ...four('src/a/b/c/infer_cli.py'),
      { name: 'port', source_file: 'src/a/b/other.py', group: '(root)', required: false },
    ]
    const got = buildEntryCandidates(root, params, {
      recommended: 'src/a/b/c/infer_cli.py',
      declaredModules: ['pkg.installed_cli'],
    })
    assert.ok(!got.some((c) => c.file === 'webui.py'), '网页界面不该出现在下拉里')
    const top = got[0]
    assert.strictEqual(top.file, 'src/a/b/c/infer_cli.py')
    assert.strictEqual(top.module, 'a.b.c.infer_cli', 'src 布局要剥掉 src. 前缀')
    assert.strictEqual(top.srcRoot, 'src')
    assert.strictEqual(top.score, 4)
    assert.strictEqual(top.recommended, true)
    assert.ok(got.some((c) => c.module === 'pkg.installed_cli' && c.file === null),
      '打包声明点过名、盘上没有源文件的模块也要能选')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('没有扫描参数时清单仍有内容：识别不出也要有得选', () => {
  const { root, write } = makeTree()
  try {
    write('deep/a/b/c/infer.py', '')
    const got = buildEntryCandidates(root, [], {})
    assert.strictEqual(got.length, 1)
    assert.strictEqual(got[0].score, 0)
    assert.strictEqual(got[0].module, 'deep.a.b.c.infer')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
