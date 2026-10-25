'use strict'
// 拖拽落点的行为测试：把左栏扫到的参数拖进界面参数区，名片会变成什么样。
//
// 这一步是纯计算（applyParamDrop），所以能单独测。
// 它碰的是名片的两个地方：parameters[]（界面参数）与 call.args（命令行形态）。
// 写错的后果都是静默的：参数在界面上调了、请求里到了、引擎那边没收到。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const SOURCE = path.join(EDITOR_DIR, 'paramDrop.js')
const TYPE_SOURCE = path.join(EDITOR_DIR, 'paramType.js')

/**
 * 加载 editor/paramDrop.js 里的 applyParamDrop 与 paramNameOf。
 * 用项目 Vite 依赖的同一个 esbuild 编译成 CJS 后取其导出。
 * paramType 是真的那一份（不是替身）：类型映射错在这里，落点的类型就错。
 *
 * 这两个函数原先在 ParamDropZone.jsx 里。那个文件是组件模块，
 * 而 vite 的 react 插件要求组件模块只导出组件：
 * 导出别的函数 ⇒ Fast Refresh 失效，改那个文件会整页 reload。
 * 纯函数搬到了自己的文件，这个测试也跟着改指新位置。
 */
function loadDrop () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  if (!esbuild) {
    throw new Error('拿不到 esbuild，拖拽落点的编译测试无法运行')
  }
  const typeSrc = fs.readFileSync(TYPE_SOURCE, 'utf8')
  const typeCode = esbuild.transformSync(typeSrc, {
    loader: 'js', format: 'cjs', target: 'node18',
  }).code
  const typeMod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', typeCode)(
    typeMod.exports, (id) => { throw new Error('paramType 不该有依赖：' + id) },
    typeMod, TYPE_SOURCE, EDITOR_DIR)

  const src = fs.readFileSync(SOURCE, 'utf8')
  const code = esbuild.transformSync(src, {
    loader: 'js',
    format: 'cjs',
    target: 'node18',
  }).code
  const mod = { exports: {} }
  const stub = (id) => {
    if (/paramType/.test(id)) return typeMod.exports
    throw new Error('拖拽落点的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, SOURCE, EDITOR_DIR)
  return mod.exports
}

const { applyParamDrop, paramNameOf } = loadDrop()

// 夹具：扫到的参数，形状与 /wizard/discover 返回的一致。
const CLI_PARAM = {
  source: 'cli', name: 'speed', target: '--speed', kind: 'number',
  style: 'value', help: 'speaking rate', required: false, group: 'infer', is_tool: false,
}
const PY_PARAM = {
  source: 'python', name: 'speed', target: 'speed', kind: 'number',
  help: 'speaking rate', required: false, group: 'call', is_tool: false,
}

test('守卫：这份测试真的拿到了活代码里的那两个纯函数', () => {
  assert.equal(typeof applyParamDrop, 'function')
  assert.equal(typeof paramNameOf, 'function')
})

// 参数名：命令行开关去掉横线，python 参数名原样。
test('cli 参数名：去掉开关前面的横线', () => {
  assert.equal(paramNameOf(CLI_PARAM), 'speed')
  assert.equal(paramNameOf({ source: 'cli', name: 'ref_audio', target: '--ref-audio' }), 'ref_audio')
})

test('python 参数名：原样，就是上游方法的那个参数名', () => {
  assert.equal(paramNameOf(PY_PARAM), 'speed')
})

// 落下：写进 parameters[]。
test('拖一个 cli 参数进去：parameters[] 多一条，名字与类型都在', () => {
  const m = applyParamDrop({}, CLI_PARAM)
  assert.equal(m.parameters.length, 1)
  assert.equal(m.parameters[0].name, 'speed')
  assert.equal(m.parameters[0].type, 'number', '类型由扫到的 kind 推出')
  assert.equal(m.parameters[0].help, 'speaking rate', '上游原话说明带进来')
})

test('拖一个 python 参数进去：parameters[] 多一条，不写 call.args', () => {
  const m = applyParamDrop({ call: { kind: 'python', module: 'm', class: 'C' } }, PY_PARAM)
  assert.equal(m.parameters.length, 1)
  assert.equal(m.parameters[0].name, 'speed')
  assert.equal(m.call.args, undefined,
    'python 形态的名片里写 args 段，存的时候会被拒')
})

// 落点与运行时的关系：cli 形态的宿主只认 call.args 里声明过的名字。
test('拖一个 cli 参数进去：cli 形态的名片同时写 call.args', () => {
  const m = applyParamDrop({ call: { kind: 'cli', argv: ['{engine_python}', '-m', 'x'] } }, CLI_PARAM)
  assert.deepStrictEqual(m.call.args.speed, { flag: '--speed', style: 'value' },
    '参数名必须在 call.args 里声明它对应哪个开关，否则宿主当场拒')
})

test('拖同一个参数两次：不出现两条同名参数', () => {
  let m = applyParamDrop({}, CLI_PARAM)
  m = applyParamDrop(m, CLI_PARAM)
  assert.equal(m.parameters.length, 1, '拖两次同一个东西不该出现两条')
})

// 已有的内容不被覆盖：用户手填过的映射比扫描猜的准。
test('名片里已有的 call.args 不被覆盖', () => {
  const m = applyParamDrop({
    call: { kind: 'cli', args: { speed: { flag: '--custom-speed', style: 'value' } } },
  }, CLI_PARAM)
  assert.equal(m.call.args.speed.flag, '--custom-speed',
    '用户手填过的映射被扫描结果盖掉了')
})

test('名片里已有的同名界面参数不被覆盖', () => {
  const m = applyParamDrop({
    parameters: [{ name: 'speed', type: 'select', tier: 'advanced', choices: ['a', 'b'] }],
  }, CLI_PARAM)
  assert.equal(m.parameters.length, 1)
  assert.equal(m.parameters[0].type, 'select', '已有参数的类型被改了')
  assert.deepStrictEqual(m.parameters[0].choices, ['a', 'b'])
})

// 不改传进来的名片。
test('不改传进来的名片：入参不被就地改写', () => {
  const card = { call: { kind: 'cli', args: {} }, parameters: [] }
  const snapshot = JSON.stringify(card)
  applyParamDrop(card, CLI_PARAM)
  assert.equal(JSON.stringify(card), snapshot, '拖拽就地改了入参')
})

// 落点之外的字段不动。
test('名片里其它段不受影响', () => {
  const m = applyParamDrop({
    id: 'x', label: 'x', runtime: { python: 'engines/x/.venv' },
    capabilities: { output_sample_rate: 24000 },
  }, CLI_PARAM)
  assert.equal(m.id, 'x')
  assert.equal(m.runtime.python, 'engines/x/.venv')
  assert.equal(m.capabilities.output_sample_rate, 24000)
})
