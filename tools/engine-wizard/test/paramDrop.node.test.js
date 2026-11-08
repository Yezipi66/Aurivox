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
  // paramFields 同样是零依赖的纯函数文件：boolStyle 用真的那一份，
  //   替身会让「布尔写成哪种样式」这件事测不到。
  const fieldsSrc = esbuild.transformSync(
    fs.readFileSync(path.join(EDITOR_DIR, 'paramFields.js'), 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const fieldsMod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', fieldsSrc)(fieldsMod.exports, () => {
    throw new Error('paramFields 不该有依赖')
  }, fieldsMod)
  const stub = (id) => {
    if (/paramType/.test(id) && !/paramShape/.test(id)) return typeMod.exports
    if (/paramShape/.test(id)) return shapeMod.exports
    if (/paramFields/.test(id)) return fieldsMod.exports
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
  assert.deepStrictEqual(m.parameters[0].help, { zh: 'speaking rate', en: 'speaking rate' },
    '上游原话说明带进来；help 是成对对象，平台只认这一种形状')
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

test('拖一个向量参数：声明成 vector，八维八个名字，默认值留空', () => {
  const m = applyParamDrop({ call: { kind: 'cli', args: {} } }, VEC_PARAM)
  const entry = m.parameters[0]
  assert.equal(entry.type, 'vector', 'vector 是独立控件，不是 number 加 repeat')
  assert.equal(entry.item, undefined, '每格用 text，不再声明每维的类型')
  assert.deepStrictEqual(entry.dim_labels, new Array(8).fill('').map(() => ({ zh: '', en: '' })),
    '八维就是八个中英文名字，先留空让使用者填：上游只写了几维，没写每维叫什么')
  assert.equal(entry.repeat, undefined,
    '维度数只由 dim_labels 的长度定，再写一个 repeat 就是第二份会漂移的事实')
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

// 布尔与候选值的预填：拖进来就该是对的，使用者只需要填名字。
//   上游把开关写成 --x/--no-x 时，取消勾选要发否定式；只写 --x 时什么都不发。
//   这两种在名片里是两种 style，写错的表现是命令行上多出一个 True / False。
test('布尔参数：双写法落成 boolean_optional，单写法落成 boolean', () => {
  const dual = applyParamDrop({ call: { kind: 'cli', args: {} } }, {
    source: 'cli', name: 'half', target: '--half', kind: 'boolean',
    style: 'boolean_optional', negative: '--no-half', required: false, group: '(root)',
  })
  assert.strictEqual(dual.parameters[0].type, 'boolean')
  assert.deepStrictEqual(dual.call.args.half, { flag: '--half', style: 'boolean_optional' })

  const single = applyParamDrop({ call: { kind: 'cli', args: {} } }, {
    source: 'cli', name: 'verbose', target: '--verbose', kind: 'boolean',
    style: 'boolean', required: false, group: '(root)',
  })
  assert.deepStrictEqual(single.call.args.verbose, { flag: '--verbose', style: 'boolean' })
})

test('布尔参数：扫描只给了 value 时也按布尔写，避免拼出 --x True', () => {
  const m = applyParamDrop({ call: { kind: 'cli', args: {} } }, {
    source: 'cli', name: 'half', target: '--half', kind: 'boolean',
    style: 'value', required: false, group: '(root)',
  })
  assert.strictEqual(m.call.args.half.style, 'boolean')
})

test('下拉参数：上游给的候选铺成选项表，不再是一张空表', () => {
  const m = applyParamDrop({ call: { kind: 'cli', args: {} } }, {
    source: 'cli', name: 'mode', target: '--mode', kind: 'str', style: 'value',
    choices: ['fast', 'accurate'], default: 'accurate', required: false, group: '(root)',
  })
  const row = m.parameters[0]
  assert.strictEqual(row.type, 'select')
  assert.deepStrictEqual(row.choices.map((c) => c.value), ['fast', 'accurate'])
  assert.strictEqual(row.suggested_value, 'accurate', '上游写的默认值就是界面初值')
})

test('数值参数：上游的默认值填进 suggested_value；文本默认值不抄', () => {
  const num = applyParamDrop({ call: { kind: 'cli', args: {} } }, {
    source: 'cli', name: 'temperature', target: '--temperature', kind: 'number',
    style: 'value', default: 0.8, required: false, group: '(root)',
  })
  assert.strictEqual(num.parameters[0].suggested_value, 0.8)

  const txt = applyParamDrop({ call: { kind: 'cli', args: {} } }, {
    source: 'cli', name: 'text', target: '--text', kind: 'str',
    style: 'value', default: 'demo sentence', required: false, group: '(root)',
  })
  assert.strictEqual(txt.parameters[0].suggested_value, undefined,
    '文本默认值常是示例句子，抄进界面等于替人写了正文')
})
