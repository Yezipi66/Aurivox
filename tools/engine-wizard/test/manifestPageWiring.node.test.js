'use strict'
// 第 4 步的接线：引擎下拉与逃生口走同一条切换，保存后的回读不拿响应对象当引擎 id。
//   reloadFacts 的参数是引擎 id，而保存回调传的是保存结果对象。
//   直接接上去会去查 install-state?id=%5Bobject%20Object%5D，
//   表现是保存名片后权重路径、权重徽标与第 3 步清单反而被清空。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const APP = fs.readFileSync(path.join(EDITOR_DIR, 'App.jsx'), 'utf8')
const IDENTITY = fs.readFileSync(path.join(EDITOR_DIR, 'EngineIdentity.jsx'), 'utf8')

function pickEngineBody () {
  const start = IDENTITY.indexOf('const pickEngine')
  if (start < 0) return ''
  const end = IDENTITY.indexOf('\n  }', start)
  return end > start ? IDENTITY.slice(start, end + 4) : ''
}

test('第 4 步的引擎下拉走 switchEngine，与逃生口同一条切换', () => {
  assert.match(APP, /onPickEngineTarget=\{switchEngine\}/,
    '第 4 步下拉没接 switchEngine：换引擎只改 wz.id，名片与完成状态不跟')
  assert.doesNotMatch(APP, /onPickEngineTarget=\{pickEngine\}/,
    '第 4 步还接着只改 id 的那一条：与 2、3、5 步语义不一致')
})

test('保存后的回读忽略回调参数，不拿响应对象当引擎 id', () => {
  assert.match(APP, /onSaved=\{\(\) => reloadFacts\(/,
    'onSaved 直接接了 reloadFacts：保存结果对象会被当成引擎 id')
  assert.doesNotMatch(APP, /onSaved=\{reloadFacts\}/,
    'onSaved 直接接 reloadFacts 会把对象交给 install-state')
})

test('第 4 步换引擎不自动读盘，读取由使用者点「读取参数」', () => {
  const pick = pickEngineBody()
  assert.ok(pick, 'EngineIdentity 里找不到 pickEngine')
  assert.doesNotMatch(pick, /loadOne\(/,
    '换引擎时自动读了盘上的名片：读取 / 创建名片应当由人点「读取参数」')
  assert.match(pick, /manifestForEngineSwitch/,
    '换引擎没把上一台的名片内容清掉')
})
