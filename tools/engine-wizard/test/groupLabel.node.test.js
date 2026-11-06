'use strict'
// 分组名旁边的中文注：原名必须留在前面（命令行上要敲的就是它），注只在括号里。
// 表里没有的名字原样返回；'(root)' 是平台占位，只留中文。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SOURCE = path.join(__dirname, '..', 'editor', 'groupLabel.js')

function load () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  assert.ok(esbuild, '拿不到编译依赖')
  const code = esbuild.transformSync(fs.readFileSync(SOURCE, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(
    mod.exports, () => { throw new Error('纯函数模块不该有依赖') }, mod)
  return mod.exports
}

const { groupLabel, hasGloss } = load()

test('常见的子命令名带注，原名在前', () => {
  assert.equal(groupLabel('synth'), 'synth（合成语音）')
  assert.equal(groupLabel('init'), 'init（初始化配置）')
  assert.equal(groupLabel('download'), 'download（下载权重）')
  assert.equal(groupLabel('batch'), 'batch（批处理）')
})

test('表里没有的名字原样返回，不硬套一个意思', () => {
  assert.equal(groupLabel('frobnicate'), 'frobnicate')
  assert.equal(hasGloss('frobnicate'), false)
})

test('(root) 是平台占位，不摆一个假的原名', () => {
  assert.equal(groupLabel('(root)'), '顶层（无子命令）')
})

test('空值不炸', () => {
  assert.equal(groupLabel(''), '')
  assert.equal(groupLabel(null), '')
})
