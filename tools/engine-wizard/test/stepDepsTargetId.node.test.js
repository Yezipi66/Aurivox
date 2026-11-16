'use strict'
// 第 2 步该认哪台引擎：234 是三个独立的接入子，都围绕第 1 步留下的全局目标。
//   切引擎后 prep 还是上一帧的会话，若拿会话 id 当目标并反向写回全局，
//   这次切换就被静默回滚，而界面其余部分停在新引擎。第 3 步已按此修好，
//   这里守第 2 步走同一条规则，防止两边再次分叉。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'editor', 'StepDeps.jsx'), 'utf8')

test('第 2 步认全局目标，不被会话 id 反向覆盖', () => {
  assert.match(SRC, /const targetId = engineId \|\| sessionId/,
    '已提交的全局目标必须优先；会话 id 只在目标为空时兜底')
  assert.doesNotMatch(SRC, /const targetId = sessionId \|\| engineId/,
    '会话 id 优先会让一次切换被上一帧的旧会话静默回滚')
})

test('onFixId 只在全局目标尚未写下来时补一次', () => {
  const fix = (SRC.match(
    /React\.useEffect\(\(\) => \{\s*if \(!state\.id && sessionId && onFixId\)[\s\S]*?\}, \[sessionId, state\.id\]\)/)
    || [''])[0]
  assert.ok(fix,
    'onFixId 只能在全局目标为空那一帧补写，不能拿旧会话 id 改已提交目标')
})
