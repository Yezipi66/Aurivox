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
  // paramShape 也是零依赖的纯函数文件，一起加载：替换成替身就测不到真的判定。
  const shapeSrc = esbuild.transformSync(
    fs.readFileSync(path.join(EDITOR_DIR, 'paramShape.js'), 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const shapeMod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', shapeSrc)(shapeMod.exports, () => {
    throw new Error('paramShape 不该有依赖')
  }, shapeMod)
  const stub = (id) => {
    if (/paramType/.test(id) && !/paramShape/.test(id)) return typeMod.exports
    if (/paramShape/.test(id)) return shapeMod.exports
    throw new Error('拖拽落点的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('exports', 'require', 'module', '__filename', '__dirname', code)
  run(mod.exports, stub, mod, SOURCE, EDITOR_DIR)
  return mod.exports
}

const { applyParamDrop, paramNameOf, migrateLegacyParams, dragLabelOf } = loadDrop()

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
  assert.equal(typeof migrateLegacyParams, 'function')
  assert.equal(typeof dragLabelOf, 'function')
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

// 旧格式（params.schema + load_time/call_time）与新格式（parameters[]）只允许存在一份。
//   盘上四台引擎的名片都是旧格式，用户一拖参数就会同时有两种，存盘被校验直接拒掉。
//   所以落点先做迁移，再写新的一条。
const LEGACY = () => ({
  id: 'x', label: 'x',
  call: { kind: 'cli', argv: ['{engine_python}', '-m', 'x'],
    args: { text: { flag: '--text', style: 'value' },
            device: { flag: '--device', style: 'value', role: 'device' } },
    bind: { text: '--text' }, returns: 'file', seed: 'none' },
  params: {
    load_time: ['precision'],
    call_time: ['device', 'speed'],
    schema: {
      precision: { type: 'select', default: 'fp16', choices: ['fp16', 'fp32'], tier: 'advanced' },
      speed: { type: 'number', default: 1, min: 0.5, max: 2 },
    },
  },
})

test('旧格式名片被拖入参数时先迁移：params 消失，原有条目一条不少', () => {
  const m = applyParamDrop(LEGACY(), CLI_PARAM)
  assert.strictEqual(m.params, undefined, '两份事实会漂移，存盘时会被拒')
  const by = Object.fromEntries(m.parameters.map((p) => [p.name, p]))
  assert.deepStrictEqual(Object.keys(by).sort(), ['device', 'precision', 'speed'],
    '原有三条都在，加上新拖进来的那条（speed 已有，不重复）')
  assert.equal(by.precision.phase, 'load', 'load_time 里的改成 phase: load')
  assert.deepStrictEqual(by.precision.choices, ['fp16', 'fp32'])
  assert.equal(by.speed.suggested_value, 1, '旧格式的 default 在新格式叫 suggested_value')
  assert.equal(by.speed.min, 0.5)
  assert.equal(by.speed.phase, undefined, 'call_time 里的不写 phase')
})

test('只在 call_time 里、schema 里没有的名字也要补一条，否则命令行参数被判为永远不上命令行', () => {
  const m = applyParamDrop(LEGACY(), CLI_PARAM)
  const device = m.parameters.find((p) => p.name === 'device')
  assert.ok(device, 'device 只在 call_time 里，迁移后必须有它')
  assert.equal(device.type, 'text', 'schema 没给形状时按文本，不当成下拉')
})

test('已经是新格式的名片不被迁移动过', () => {
  const already = { id: 'x', parameters: [{ name: 'speed', type: 'number', tier: 'common' }] }
  const m = migrateLegacyParams(already)
  assert.deepStrictEqual(m.parameters, already.parameters)
  assert.strictEqual(m.params, undefined)
})

test('迁移保留 schema 的键序：界面按名片写的顺序排', () => {
  const m = migrateLegacyParams(LEGACY())
  assert.deepStrictEqual(m.parameters.map((p) => p.name), ['precision', 'speed', 'device'])
})

// 上游说明里写着「逗号分隔的 8 维」时，这一条不是一个文本框，
//   而是八个数字格 + 命令行上一个逗号串。判错会让命令行上出现 N 个词。
const VEC_PARAM = {
  source: 'cli', name: 'emotion-vector', target: '--emotion-vector',
  kind: 'str', style: 'value',
  help: 'Comma-separated 8-dimensional emotion vector',
}

test('拖一个向量参数：八个数字格，默认值留空，命令行按一个逗号串拼', () => {
  const m = applyParamDrop({ call: { kind: 'cli', args: {} } }, VEC_PARAM)
  const entry = m.parameters[0]
  assert.equal(entry.repeat, 8, '八维就是八格')
  assert.equal(entry.type, 'number', '每格是一个数')
  assert.deepStrictEqual(entry.suggested_value, new Array(8).fill(null),
    '默认值必须等长；填 null 表示这一维没填，不替人写 0')
  assert.deepStrictEqual(m.call.args['emotion-vector'],
    { flag: '--emotion-vector', style: 'join', join: ',' },
    'style 取 join：写成 value 会被按 nargs 拆成八个词')
})

test('拖一个普通参数：仍然是单值，不被向量判定波及', () => {
  const m = applyParamDrop({ call: { kind: 'cli', args: {} } }, CLI_PARAM)
  assert.strictEqual(m.parameters[0].repeat, undefined)
  assert.deepStrictEqual(m.call.args.speed, { flag: '--speed', style: 'value' })
})

test('向量参数名与开关名不同：落盘用去横线的那个作键', () => {
  const m = applyParamDrop({ call: { kind: 'cli', args: {} } }, VEC_PARAM)
  assert.equal(m.parameters[0].name, 'emotion-vector')
  assert.ok(m.call.args['emotion-vector'], 'args 的键与 parameters 的 name 同名')
})

test('拖拽标签：跟着光标走的是命令行上的写法，不是 JSON', () => {
  assert.equal(dragLabelOf(VEC_PARAM), '--emotion-vector')
  assert.equal(dragLabelOf({ source: 'python', name: 'seed', target: 'seed' }), 'seed')
  assert.equal(dragLabelOf(null), '')
})
