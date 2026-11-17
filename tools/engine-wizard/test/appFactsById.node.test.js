'use strict'
// 完成状态按引擎分槽：234 是三个独立的接入子，每台有自己的完成状态。
//   切回一台时立刻显示它自己那份，不拿上一台的快照顶上，也不等新请求回来。
// 这里守 App.jsx 的三处接线：存的是 map、done 从当前引擎取、写回只写自己的槽。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'editor', 'App.jsx'), 'utf8')

test('完成状态按引擎存成 map，当前那份从 map 里取', () => {
  assert.match(APP, /useState\(\{\}\)\s*\n\s*const facts = factsById\[wz\.id\] \|\| \{\}/,
    'facts 必须是 factsById[wz.id]，不能是全局单一值')
  assert.doesNotMatch(APP, /const \[facts, setFacts\]/,
    '单一 facts 会让另一台的完成状态串到当前这台')
})

test('factsId 是派生值，不再单独 set', () => {
  assert.match(APP, /const factsId = wz\.id \|\| null/,
    '守卫用的 factsId 必须来自当前全局目标')
  assert.doesNotMatch(APP, /setFactsId\(/,
    '再单独 set factsId 就会出现与 wz.id 不同源的第二种真相')
})

test('写回只写这一台的槽，不动另一台', () => {
  assert.match(APP,
    /setFactsById\(\(cur\) => \(\{ \.\.\.cur, \[id\]: j\.steps_done \}\)\)/,
    'install-state 回包必须写进它自己 id 的槽')
})
