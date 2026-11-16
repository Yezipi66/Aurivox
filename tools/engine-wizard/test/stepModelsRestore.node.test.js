'use strict'
// 第 3 步切页回来不能丢清单：234 是三个独立的接入子，各自的状态存在会话段里。
//   重挂时恢复 effect 先 setManifest(saved.manifest)，但 load() 里无条件
//   setManifest(null)，两个 effect 同批执行，后写的 null 把恢复结果冲掉。
//   现在 load() 只在会话段没有存档时才组装，这里守这条顺序。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'editor', 'StepsExtra.jsx'), 'utf8')

test('恢复 effect 在 load effect 之前，先把清单读回来', () => {
  const restore = SRC.indexOf('loadDownloadState(id, state.repoUrl || \'\')')
  const loadFx = SRC.indexOf('if (!id || r || busy) return')
  assert.ok(restore > 0 && loadFx > 0, '两处 effect 都还在')
  assert.ok(restore < loadFx, '恢复 effect 必须排在 load effect 前面')
})

test('load 前先看会话段，有存档就不组装（不再冲掉恢复的清单）', () => {
  const guard = (SRC.match(
    /if \(!id \|\| r \|\| busy\) return\s*\n\s*if \(loadDownloadState\(id, state\.repoUrl \|\| ''\)\) return\s*\n\s*load\(\)/)
    || [''])[0]
  assert.ok(guard,
    'load() 之前必须检查 loadDownloadState，有存档就跳过组装')
})
