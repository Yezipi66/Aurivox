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

test('扫描写回把认出的开关落成合成参数的参数行', () => {
  // 扫描只写 call.args 与 params.call_time 时，界面上没有任何一格对应那批开关，
  //   人于是对着一个空表发愁：参数明明扫出来了，却要再手拖一遍才看得见。
  //   守的是「点一次扫描，参数表就该有内容」这条路径。
  assert.match(PAGE, /addParamsFromScan/,
    '扫描写回没有落成 parameters[]，合成参数表会一直是空的')
  assert.match(PAGE, /next\.parameters = rows\.manifest\.parameters/,
    '算出来的参数行没有写进名片，界面拿不到')
})

test('类型补齐的清单含全部扫描结果，不只入口与当前分组', () => {
  // 手敲一个属于别的子命令的开关时，清单里得有它，类型才补得上。
  //   只给「入口 + 当前分组」，那类开关在清单里查不到，于是静默停在 text，
  //   而它的类型上游明明写了（index-tts 的 --output-dir 就是这样）。
  assert.match(PAGE, /const shapeSource = scope\.params\.length\s*\?\s*\[\.\.\.scope\.params, \.\.\.scanned\.filter/,
    '类型补齐的清单要接上全量 scanned，否则手敲别的子命令的开关补不上类型')
})
