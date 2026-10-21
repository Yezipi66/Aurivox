'use strict'
// 验证 stepArtifactExists 不是恒 true 的桩：
// 造一个假的引擎目录，分别验「产物在」与「产物不在」两种情形。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const env = require('../core/env.js')

function tmpRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-'))
}

test('建环境那步：venv 不存在 ⇒ 产物不在，不许跳过', () => {
  const root = tmpRoot()
  const step = { skipIfExists: true, argv: ['uv', 'venv', 'x'] }
  const got = env.stepArtifactExists(step, root, 'no-such-engine')
  assert.strictEqual(got, false, '空目录下建环境那步必须判产物不在')
  fs.rmSync(root, { recursive: true, force: true })
})

test('装包那步：site-packages 为空 ⇒ 产物不在，不许跳过', () => {
  const root = tmpRoot()
  const id = 'fake'
  const sp = process.platform === 'win32'
    ? path.join(root, 'engines', id, '.venv', 'Lib', 'site-packages')
    : path.join(root, 'engines', id, '.venv', 'lib', 'python3.11', 'site-packages')
  fs.mkdirSync(sp, { recursive: true })
  const step = { argv: ['uv', 'pip', 'install', '-r', 'requirements.txt'] }
  assert.strictEqual(env.stepArtifactExists(step, root, id), false,
    'site-packages 空目录必须判产物不在')
  fs.rmSync(root, { recursive: true, force: true })
})

test('装包那步：site-packages 非空 ⇒ 产物在，可以跳过', () => {
  const root = tmpRoot()
  const id = 'fake'
  const sp = process.platform === 'win32'
    ? path.join(root, 'engines', id, '.venv', 'Lib', 'site-packages')
    : path.join(root, 'engines', id, '.venv', 'lib', 'python3.11', 'site-packages')
  fs.mkdirSync(sp, { recursive: true })
  fs.writeFileSync(path.join(sp, 'something.py'), '# installed')
  const step = { argv: ['uv', 'pip', 'install', '-r', 'requirements.txt'] }
  assert.strictEqual(env.stepArtifactExists(step, root, id), true,
    'site-packages 有内容必须判产物在')
  fs.rmSync(root, { recursive: true, force: true })
})

test('认不出的步（conda / 纯脚本）⇒ 返回 true，不重跑', () => {
  const root = tmpRoot()
  const step = { argv: ['conda', 'env', 'create', '-f', 'environment.yml'] }
  assert.strictEqual(env.stepArtifactExists(step, root, 'x'), true,
    '认不出的步按旧行为交给命令文本判重')
  fs.rmSync(root, { recursive: true, force: true })
})
