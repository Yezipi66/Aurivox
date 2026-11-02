//  底模不齐时的拦截闸：checkpointBlock()，以及各页的合成入口有没有真的接上它。
//
// 界面上的口径：底模不齐的引擎标出未就绪，合成入口不让点，并把缺哪几个文件说清。
//
// 判据仍然只有一处：服务端 lib/engines/checkpoints.js 的三态。checkpointBlock 读的是
// checkpointBadge 已经算好的颜色，自己不判齐不齐。界面再判一次，就会出现徽章说
// 「缺底模」而按钮照样能点的两种话。
//
// 两组用例：先钉「什么状态拦、什么状态不拦」，再钉「各页的按钮有没有接上」。
// 后一组只读源码文本，无 DOM 环境跑不了 React。
//
// 单独一个文件而不是并进 engineCheckpoints.node.test.js：那个文件测「给什么状态说什么话」，
// 这一件测「这句话拦不拦得住动作」，是两件事。
// 用法：node --test web/src/lib/checkpointGate.node.test.js

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkpointBlock } from './engines.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

const engineWith = (checkpoints) => ({ id: 'demo', label: 'Demo', checkpoints })

test('底模不齐：拦，并且把缺的文件名说在标题里', () => {
  const block = checkpointBlock(engineWith({
    declared: true, ready: false, abs_path: '/r/models/demo', path_source: 'manifest',
    required: ['hubert-base', 's2G488k.pth'], missing: ['hubert-base'],
    reason: '底模目录在，但少了 1 个文件：hubert-base',
  }))
  assert.ok(block, '不齐必须给出拦截理由')
  assert.equal(block.label, '缺底模')
  assert.ok(block.title.includes('/r/models/demo'), '标题要交代底模在哪')
  assert.ok(block.title.includes('hubert-base'), '标题要点名缺的那一个')
})

test('底模齐：不拦', () => {
  assert.equal(checkpointBlock(engineWith({
    declared: true, ready: true, abs_path: '/r/models/demo', path_source: 'manifest', missing: [],
  })), null)
})

test('说不出齐不齐：不拦。目录在但名片没点名文件，说不出不等于缺', () => {
  assert.equal(checkpointBlock(engineWith({
    declared: true, ready: null, abs_path: '/r/models/demo', path_source: 'manifest',
    entries: 3, required: [], missing: [],
    reason: '目录在（3 项），但 manifest.json 的 models.required 没点名任何文件，平台说不出它齐不齐',
  })), null)
})

test('名片没写底模目录：不拦，显示的是「?」而不是缺失', () => {
  assert.equal(checkpointBlock(engineWith({
    declared: false, ready: null, abs_path: null, path_source: null,
    reason: 'manifest.json 里没写 runtime.checkpoints',
  })), null)
})

test('引擎列表还没回来：不拦，不能先禁用按钮再恢复', () => {
  assert.equal(checkpointBlock(null), null)
  assert.equal(checkpointBlock({ id: 'demo' }), null)
})

test('英文界面用英文的说法，与徽章同一处产出', () => {
  const block = checkpointBlock(engineWith({
    declared: true, ready: false, abs_path: '/r/models/demo', path_source: 'manifest',
    required: ['a.bin'], missing: ['a.bin'], reason: 'missing 1 file: a.bin',
  }), 'en')
  assert.equal(block.label, 'no weights')
})

const GATES = [
  ['components/generate/GenerateTab.jsx', /disabled=\{loading \|\| !!ckBlock\}/, '生成页 Generate 按钮'],
  ['components/compare/ReferenceCompareTab.jsx', /rows\.some\(r => r\.loading\) \|\| !!ckBlock/, '对比页 Generate All 按钮'],
]

test('各页的合成按钮都接在闸上', () => {
  for (const [rel, re, what] of GATES) {
    assert.match(read(rel), re, `${what}（${rel}）必须带 !!ckBlock`)
  }
  const rowSrc = read('components/compare/CompareRow.jsx')
  assert.equal((rowSrc.match(/disabled=\{row\.loading \|\| !!ckBlock\}/g) || []).length, 2,
    '对比行内的生成按钮与结果区重跑按钮都要接上')
})

test('拦住时把话说在面上：生成页与对比页各有一段可见说明', () => {
  for (const rel of ['components/generate/GenerateTab.jsx', 'components/compare/ReferenceCompareTab.jsx']) {
    const src = read(rel)
    assert.match(src, /className="msg msg-danger"/, `${rel} 要有摆在界面上的说明，不能只留悬停`)
    assert.ok(src.includes('{ckBlock.title}'), `${rel} 的说明文字取自徽章标题，不另写一份`)
  }
})

test('顶栏引擎选择器标出未就绪，但不把它从列表里摘掉', () => {
  const src = read('App.jsx')
  assert.match(src, /checkpointBlock\(en, lang\)/, '选择器逐项读闸')
  assert.doesNotMatch(src, /engines\.filter\([^)]*ckBlock/, '不齐的引擎不许被从下拉里滤掉')
})

test('引擎管理页每一行也显示底模徽章（去补文件的就是在这一页）', () => {
  assert.match(read('components/engines/EnginesTab.jsx'), /checkpointBadge\(engine, lang\)/,
    '行内要读同一处徽章')
})

test('页面不自己判底模：三处入口只读闸，不直接读 checkpoints.ready', () => {
  for (const rel of [
    'components/generate/GenerateTab.jsx',
    'components/compare/ReferenceCompareTab.jsx',
    'components/compare/CompareRow.jsx',
    'App.jsx',
  ]) {
    assert.doesNotMatch(read(rel), /checkpoints\.ready/, `${rel} 里不该出现第二次判断`)
  }
})
