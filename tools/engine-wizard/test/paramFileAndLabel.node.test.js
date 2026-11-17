'use strict'
// 扫描写回名片时两件该补没补的事：
//   ① 收文件路径的参数落进 text，合成页给不出「选择文件」控件；
//   ② 英文名空着，明明参数名去掉横线就能填（--model-dir ⇒ model-dir）。
// 这里用活代码测：类型映射 paramType.js 与补齐 fillTypesFromScan。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const { esbuild } = require('../../../lib/testDeps.js')

function load (file, deps) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR, file), 'utf8'), {
    loader: 'js', format: 'cjs', target: 'node18',
  }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, (id) => {
    if (deps && deps[id]) return deps[id]
    throw new Error(file + ' 不该求值依赖：' + id)
  }, mod)
  return mod.exports
}

const typeMod = load('paramType.js')
const { paramTypeOf, looksLikeFile } = typeMod
// paramDrop 依赖 paramType 与 paramShape，都给真的
const shapeMod = load('paramShape.js')
const fieldsMod = load('paramFields.js')
const drop = load('paramDrop.js', {
  './paramType.js': typeMod,
  './paramShape.js': shapeMod,
  './paramFields.js': fieldsMod,
})

test('收文件的参数认成 file：目录、wav、模型路径', () => {
  for (const name of ['model-dir', 'prompt-wav', 'checkpoint-file', 'audio_path', 'output-file']) {
    assert.strictEqual(paramTypeOf({ name, kind: 'str' }), 'file',
      name + ' 收的是路径，落进 text 就没有文件控件了')
  }
  assert.strictEqual(paramTypeOf({ name: 'path', kind: 'str', help: 'path to the model file' }), 'file')
})

test('名字里带 model 不等于文件：model-name / model-type 仍是文本', () => {
  assert.strictEqual(looksLikeFile({ name: 'model-name', kind: 'str' }), false)
  assert.strictEqual(paramTypeOf({ name: 'model-type', kind: 'str' }), 'text')
  assert.strictEqual(paramTypeOf({ name: 'speed', kind: 'float' }), 'number')
})

test('按扫描补类型时，英文名取参数名去掉横线', () => {
  const manifest = {
    id: 'x',
    parameters: [{ name: 'model-dir', type: 'text', tier: 'common' }],
    call: { kind: 'cli', args: { 'model-dir': { flag: '--model-dir' } } },
  }
  const scanned = [{ name: 'model-dir', target: '--model-dir', kind: 'str', help: 'path to model' }]
  const r = drop.fillTypesFromScan(manifest, scanned)
  assert.strictEqual(r.filled, 1)
  assert.strictEqual(r.manifest.parameters[0].type, 'file')
  assert.strictEqual(r.manifest.parameters[0].label.en, 'model-dir',
    '英文名该按参数名填，不是留空让人手敲')
})

test('类型不变的文本参数也能补英文名', () => {
  const manifest = {
    id: 'x',
    parameters: [{ name: 'speed', type: 'number', tier: 'common' }],
    call: { kind: 'cli', args: {} },
  }
  const scanned = [{ name: 'speed', target: '--speed', kind: 'float' }]
  const r = drop.fillTypesFromScan(manifest, scanned)
  assert.strictEqual(r.filled, 1, '类型虽没变，英文名空着也该算可补')
  assert.strictEqual(r.manifest.parameters[0].label.en, 'speed')
})

test('人已经填过的英文名不被覆盖', () => {
  const manifest = {
    id: 'x',
    parameters: [{ name: 'speed', type: 'number', label: { en: 'Speed factor' }, tier: 'common' }],
    call: { kind: 'cli', args: {} },
  }
  const scanned = [{ name: 'speed', target: '--speed', kind: 'float' }]
  assert.strictEqual(drop.countUnshapedParams(manifest, scanned), 0)
  const r = drop.fillTypesFromScan(manifest, scanned)
  assert.strictEqual(r.filled, 0)
  assert.strictEqual(r.manifest.parameters[0].label.en, 'Speed factor')
})
