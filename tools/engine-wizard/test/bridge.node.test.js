'use strict'
// ⭐ wizardbridge 的 import 守卫
//
// ⚠ 这份测试存在的理由（2026-10-04 实测踩过）：
//   handleProbe 里用了 `parseRepoUrl`，但顶部只解构了 `resolveEngine`
//   ⇒ 运行时 ReferenceError。
//   ⛔ 而 Vite 会把它 minify 成 `h is not a function` —— 一个**完全
//     指向不了错误位置**的报错。我为此绕了十几轮（怀疑缓存、怀疑网络、
//     怀疑中间件），最后靠「在纯 node 里模拟中间件」才拿到真栈。
//
//  ⇒ 这条守卫扫的是**「用了但没导入」**：
//   把每个 `xxx(` 的调用跟顶部解构出来的名字对一遍。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const F = path.join(__dirname, '..', 'core', 'wizardbridge.js')

/** 剥掉注释和字符串，避免把注释里的词当代码 */
function codeOnly (src) {
  let out = ''
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
    out += line + '\n'
  }
  return out
}

test('⭐ 顶部把用到的每个函数都导入了吗', () => {
  const code = codeOnly(fs.readFileSync(F, 'utf-8'))

  // ---- 顶部解构出来的名字 ----
  const imported = new Set()
  for (const m of code.matchAll(
    /const\s*\{([^}]+)\}\s*=\s*require\([^)]+\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim()
      if (name) imported.add(name)
    }
  }
  // 单个 require
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*require\([^)]+\)/g)) {
    imported.add(m[1])
  }
  // 本文件定义的（function 声明 / const 箭头 / 本文件参数）
  for (const m of code.matchAll(/function\s+(\w+)\s*\(/g)) imported.add(m[1])
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) imported.add(m[1])
  for (const m of code.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/[=\s]/)[0]
      if (n && /^\w+$/.test(n)) imported.add(n)
    }
  }

  // ---- 本文件 export 的 require 名（也可能被用） ----
  const REQUIRED = ['fetchRaw', 'json', 'readBody', 'https', 'fs', 'path',
    'setTimeout', 'URL', 'Buffer']
  for (const n of REQUIRED) imported.add(n)

  // ---- 找「调用了但没定义/没导入」的 ----
  const CALLED = ['parseRepoUrl', 'resolveEngine', 'runClone', 'buildClonePlan',
    'runEnv', 'buildEnvPlan', 'describeModels', 'explainMissingInfo',
    'probeProject', 'detectDependencyFile', 'json', 'readBody', 'fetchRaw',
    'verifyChecks', 'runChecks', 'runAudioCheck']

  const missing = CALLED.filter((n) => {
    if (imported.has(n)) return false
    // ⛔ 真的在代码里被调用过才算（而不是只出现在 import 语句里）
    return new RegExp(`(?<![\\w.])${n}\\s*\\(`).test(code)
  })

  assert.deepStrictEqual(missing, [],
    `⛔ 用了但没导入：${missing.join(', ')} —— `
    + '运行时会 ReferenceError，而 Vite 会 minify 成「h is not a function」，'
    + '报错指向不了真正的位置')
})

test('⭐ 本文件 export 出来的每个 handler 都是函数', () => {
  const m = require(F)
  for (const [k, v] of Object.entries(m)) {
    if (k === 'path') continue          // ⛔ node 的 path 模块，本就不是函数
    assert.strictEqual(typeof v, 'function', `${k} 不是函数（是 ${typeof v}）`)
  }
})

test('⭐ 七个步骤的端点都在', () => {
  const m = require(F)
  for (const h of ['handleResolve', 'handleProbe', 'handleClone',
    'handleEnv', 'handleModels', 'handleState',
    'handleVerify', 'handleVerifyChecks']) {
    assert.strictEqual(typeof m[h], 'function', `⛔ 少了 ${h}`)
  }
})

test('⭐ ⛔ 长前缀必须排在短前缀之前（/verify/checks 会被 /verify 吃掉）', () => {
  // ⚠ 中间件是「第一个返回 true 的赢」，⛔ 顺序错了长前缀永远匹配不上
  // ⚠ 路径：web/ 在**项目根**，⛔ 不在 tools/ 下
    //   （写错了会 ENOENT，测试报「文件不存在」而不是「顺序不对」——
    //     那是个看不出真相的失败。2026-10-04 实测踩过）
    const cfg = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'web', 'wizard.vite.config.mjs'),
      'utf-8')
  const m = cfg.match(/const HANDLERS = \[([\s\S]*?)\]/)
  assert.ok(m, '⛔ 找不到 HANDLERS 数组')
  // ⛔ 别按逗号切：源码里一行可能有多个（handleSpec, handleRead）
  const list = (m[1].match(/\b(handle[A-Za-z]+|validateId)\b/g) || [])
  assert.ok(list.length >= 8, `⛔ 只解析出 ${list.length} 个：${list.join(',')}`)
  const iChecks = list.indexOf('handleVerifyChecks')
  const iVerify = list.indexOf('handleVerify')
  assert.ok(iChecks >= 0 && iVerify >= 0, '⛔ 两个 verify handler 都要在表里')
  assert.ok(iChecks < iVerify,
    '⛔ handleVerifyChecks（长前缀）必须排在 handleVerify（短前缀）之前')
})

test('⛔ wizardbridge.js 活代码里不许出现具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const code = codeOnly(fs.readFileSync(F, 'utf-8'))
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})