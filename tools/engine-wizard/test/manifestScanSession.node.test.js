'use strict'
// 第 4 步的参数池扫描结果按引擎存会话段：切页回来直接读，不再跑 /wizard/discover。
//   这里守五件事：白名单字段、state 初值来自存档、换引擎读回那台的、写回、
//   已有存档时跳过静默重扫。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const SESSION = fs.readFileSync(path.join(EDITOR, 'useInstallSession.js'), 'utf8')
const PAGE = fs.readFileSync(path.join(EDITOR, 'ManifestPage.jsx'), 'utf8')

test('会话段白名单含第 4 步的扫描状态', () => {
  for (const k of ['scan', 'group', 'poolAll', 'scanErr', 'selected', 'autofill', 'guessed']) {
    assert.match(SESSION, new RegExp('\\n    ' + k + ':'),
      '白名单缺 ' + k + '，切页回来这一项会丢')
  }
})

test('扫描 state 用存档做初值，不是写死空', () => {
  assert.match(PAGE, /useState\(saved\.scan \|\| null\)/)
  assert.match(PAGE, /useState\(saved\.group \|\| ''\)/)
  assert.match(PAGE, /useState\(saved\.poolAll === true\)/)
  assert.match(PAGE, /useState\(saved\.selected \|\| null\)/)
  assert.match(PAGE, /useState\(saved\.autofill \|\| null\)/)
  assert.match(PAGE, /new Set\(saved\.guessed \|\| \[\]\)/)
})

test('换引擎读回那台的扫描状态，不是无条件清空', () => {
  const block = (PAGE.match(/React\.useEffect\(\(\) => \{\s*\n    if \(!engineKey\) return\s*\n    const s = loadSession\(engineKey\)[\s\S]*?\n  \}, \[engineKey\]\)/) || [''])[0]
  assert.ok(block, '少了按引擎恢复扫描状态的 effect')
  assert.match(block, /loadSession\(engineKey\)/)
  assert.doesNotMatch(block, /setScan\(null\); setGroup\(''\)/,
    '无条件清空会让切回一台引擎时那份扫描结果白丢')
})

test('写回会话段，且换引擎那一帧跳过（避免写上一台的旧 state）', () => {
  assert.match(PAGE, /saveSession\(engineKey, '', \{/)
  assert.match(PAGE, /restoringFor\.current === engineKey/)
})

test('有扫描存档时跳过静默重扫', () => {
  const block = (PAGE.match(/const autoScanned = React\.useRef\(''\)[\s\S]*?\n  \}, \[engineKey\]\)/) || [''])[0]
  assert.ok(block, '少了自动扫描的 effect')
  assert.match(block, /if \(s && s\.scan\) return/,
    '有存档还重扫，就还是有 /wizard/discover 的空档')
})
