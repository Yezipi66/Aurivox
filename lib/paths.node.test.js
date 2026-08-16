const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('os')

// 登记：项目布局只有一个权威，即 lib/paths.js。
//
// 本文件存在的理由。收口之前，同一个目录名散落在十余个文件里各拼各的：
// server.js 定义了十余项路径常量，lib/audio/concat.js 又重复定义了一份
// OUTPUT_DIR，lib/flowgraph/service.js 的默认值与服务端注入值并不一致，
// 而 voices.json 的位置在 server.js 与 steps/promote.js 中被各自上溯拼出。
// 结果是"搬一个目录"要翻遍全项目，且极易漏改。
//
// 收口一次是手工活，手工活会在下一个补丁里退化，因此把标准写在这里，
// 违反即测试变红。
//
// 判定方式刻意保持字面且狭窄：只在同时出现 path.join / path.resolve 的行上，
// 检查是否把下列业务目录名写成了字符串字面量。它不做风格评判，只拦截确凿的
// 重复定义。

const ROOT = path.resolve(__dirname, '..')

// 属于项目布局的名字。这些只允许出现在 lib/paths.js 里。
const LAYOUT_NAMES = [
  'outputs',
  'voices.json',
  'backups',
  'recipes',
  'custom_refs',
  'pron_lexicon',
  'advanced_params.json',
  'training_defaults.json',
  'app-config.json',
  'pretrained',
  'uvr5_weights',
  'gsv_code',
  'gsv-tools',
]

// 豁免清单。每一条都必须写明理由——没有理由的豁免等于没有规则。
const EXEMPT = new Map([
  [
    'lib/paths.js',
    '权威本身。这些名字就该在这里出现，且只在这里出现。',
  ],
  [
    'lib/paths.node.test.js',
    '本测试文件自身，需要把被禁的名字写成清单。',
  ],
  [
    'lib/__testsupport__/brokerHarness.js',
    '在临时目录里搭测试夹具，写的是夹具内部结构，与项目布局无关。',
  ],
  [
    'lib/flowgraph/service.js',
    '画布服务按设计保持可注入、不依赖应用层，其默认值仅供单元测试使用；'
    + '生产路径由 server.js 从 lib/paths.js 显式注入。',
  ],
  [
    'vendor/gsv-tools/uvr5/uvr5_models.js',
    '第三方训练工具目录内的代码，使用相对自身的默认值并接受外部覆盖；'
    + '不应反向依赖应用层的 lib/paths.js。',
  ],
])

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch (e) { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      // 跳过依赖、构建产物与第三方 Python 源码目录
      if (['node_modules', 'dist', '.git', '__pycache__'].includes(e.name)) continue
      walk(full, out)
    } else if (e.name.endsWith('.js') || e.name.endsWith('.cjs')) {
      out.push(full)
    }
  }
  return out
}

test('项目布局只在 lib/paths.js 里定义一次', () => {
  const files = walk(path.join(ROOT, 'lib'))
  const offences = []

  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (EXEMPT.has(rel)) continue

    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!/path\.(join|resolve)\s*\(/.test(line)) return
      for (const name of LAYOUT_NAMES) {
        // 只匹配被引号完整包裹的字面量，避免 'gsv-tools' 命中注释里的散文
        const re = new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}['"\`]`)
        if (re.test(line)) {
          offences.push(`${rel}:${i + 1}  硬编码了 "${name}"\n      ${line.trim()}`)
        }
      }
    })
  }

  assert.deepStrictEqual(
    offences,
    [],
    '以下位置绕过了路径权威。请改为 require("lib/paths") 取常量；'
    + '若确有正当理由，请在本文件的 EXEMPT 清单中登记并写明原因。\n\n'
    + offences.join('\n'),
  )
})

test('paths.js 导出的每一项都是绝对路径', () => {
  const P = require('./paths')
  const skip = new Set([
    'readConfig', 'writeConfig', 'ensureRuntimeDirs', 'detectAppDir', 'dataOrRoot',
    'ASSETS_ROOT_SOURCE', 'CUSTOM_REFS_DIRNAME',
    'PRETRAINED', 'OUTPUT_ROOTS', 'RUNTIME_DIRS', 'LEGACY_LOCATIONS', 'DATA_ITEMS',
  ])
  for (const [k, v] of Object.entries(P)) {
    if (skip.has(k)) continue
    assert.strictEqual(typeof v, 'string', `${k} 应为字符串`)
    assert.ok(path.isAbsolute(v), `${k} 应为绝对路径，实际为 ${v}`)
  }
  for (const [k, v] of Object.entries(P.PRETRAINED)) {
    assert.ok(path.isAbsolute(v), `PRETRAINED.${k} 应为绝对路径`)
  }
  for (const [k, v] of Object.entries(P.OUTPUT_ROOTS)) {
    assert.ok(path.isAbsolute(v), `OUTPUT_ROOTS.${k} 应为绝对路径`)
  }
  for (const d of P.RUNTIME_DIRS) {
    assert.ok(path.isAbsolute(d), `RUNTIME_DIRS 中存在非绝对路径 ${d}`)
  }
})

test('产物目录三个来源互不重合，且都在 outputs 之下', () => {
  const P = require('./paths')
  const vals = Object.values(P.OUTPUT_ROOTS)
  assert.strictEqual(new Set(vals).size, vals.length, '产物来源目录出现重复')
  for (const v of vals) {
    assert.ok(
      v.startsWith(P.OUTPUT_DIR + path.sep),
      `${v} 不在 OUTPUT_DIR 之下——产物必须集中于 outputs/`,
    )
  }
})

test('暂存根与资产根同盘，保证重命名为原子操作', () => {
  const P = require('./paths')
  // .staging 必须是 ASSETS_ROOT 的同级目录，跨盘会导致 rename 抛 EXDEV
  assert.strictEqual(
    path.dirname(path.resolve(P.STAGING_ROOT)),
    path.dirname(path.resolve(P.ASSETS_ROOT)),
    '暂存根与资产根不在同一父目录下，重命名将不再是原子操作',
  )
})

test('遗留位置备忘如实指向当前真实位置', () => {
  const P = require('./paths')
  // 备忘表里的 current 必须等于实际生效的常量，否则备忘就是过期信息
  assert.strictEqual(P.LEGACY_LOCATIONS.gsvPretrained.current, P.GSV_PRETRAINED_DIR)
  assert.strictEqual(P.LEGACY_LOCATIONS.asr.current, P.ASR_DIR)
  assert.strictEqual(P.LEGACY_LOCATIONS.uvr5Weights.current, P.UVR5_WEIGHTS_DIR)
  assert.strictEqual(P.LEGACY_LOCATIONS.inference.current, P.INFERENCE_DIR)
  // 备忘表只登记「尚未搬迁」的项。已在 data/ 之下的运行期数据不该再出现在这里。
  for (const [k, v] of Object.entries(P.LEGACY_LOCATIONS)) {
    assert.ok(
      !path.resolve(v.current).startsWith(path.resolve(P.DATA_DIR) + path.sep),
      `${k} 已经在 data/ 之下，应从遗留位置备忘中移除`,
    )
  }
})

// ---------------------------------------------------------------------------
//  项目根的判定：必须跟随入口 server.js，而不是本文件所在的位置
// ---------------------------------------------------------------------------
//  lib/ 可能是指向别处的符号链接（测试环境 brokerHarness.js 就是这么搭的），
//  此时 paths.js 的 __dirname 会落在被链接的那份仓库里。若拿它的上一级当项目
//  根，服务端就会去错误的目录读写 voices.json 等运行期文件，表现为音色一律
//  查不到（404）。这条测试锁死判定逻辑，防止再次退化。
// ---------------------------------------------------------------------------

test('项目根跟随入口 server.js，不受 lib 被链接的影响', () => {
  const P = require('./paths')
  const envSaved = process.env.AURIVOX_APP_DIR
  delete process.env.AURIVOX_APP_DIR
  const fakeRoot = path.join(os.tmpdir(), 'aurivox-app-abc')
  try {
    // 模拟：从某个临时目录启动 server.js，而 lib/ 链接回别处
    assert.strictEqual(
      P.detectAppDir(path.join(fakeRoot, 'server.js')),
      fakeRoot,
      '项目根没有跟随入口 server.js，链接式部署与集成测试都会读错目录',
    )

    // 没有 server.js 入口时（单元测试直接 require），回退到本仓库根
    assert.strictEqual(
      P.detectAppDir(null),
      path.resolve(__dirname, '..'),
      '无入口时应回退到仓库根',
    )

    // 入口不是 server.js（例如测试运行器）时同样回退
    assert.strictEqual(
      P.detectAppDir(path.join(fakeRoot, 'run_tests.cjs')),
      path.resolve(__dirname, '..'),
    )

    // 环境变量优先级最高
    process.env.AURIVOX_APP_DIR = path.join(os.tmpdir(), 'aurivox-forced')
    assert.strictEqual(
      P.detectAppDir(path.join(fakeRoot, 'server.js')),
      path.join(os.tmpdir(), 'aurivox-forced'),
    )
  } finally {
    if (envSaved === undefined) delete process.env.AURIVOX_APP_DIR
    else process.env.AURIVOX_APP_DIR = envSaved
  }
})

test('运行期数据文件都挂在项目根下，而非 lib 目录下', () => {
  const P = require('./paths')
  // 收口前这些文件由 server.js 用自身 __dirname 定位。第 2 步之后它们迁入
  // data/，但仍必须位于项目根之内——若哪天落到 lib/ 下面，或落到项目之外，
  // 既有安装的数据就会失联。
  const root = path.resolve(P.APP_DIR)
  for (const [name, val] of Object.entries({
    VOICES_JSON: P.VOICES_JSON,
    ADVANCED_PARAMS_FILE: P.ADVANCED_PARAMS_FILE,
    FLOWGRAPH_DIR: P.FLOWGRAPH_DIR,
    DATA_DIR: P.DATA_DIR,
  })) {
    const dir = path.dirname(path.resolve(val))
    assert.ok(
      dir === root || dir === path.resolve(P.DATA_DIR),
      `${name} 既不在项目根也不在 data/ 之下（实际 ${val}），既有安装的数据会失联`,
    )
    assert.ok(
      !path.resolve(val).startsWith(path.resolve(P.LIB_DIR) + path.sep),
      `${name} 落进了 lib/，运行期数据不得与代码混住`,
    )
  }
})

// ---------------------------------------------------------------------------
//  第 2 步：运行期数据迁入 data/
// ---------------------------------------------------------------------------
//  下面两条测试都在临时目录里另起一个 node 进程来解析路径。必须另起进程，
//  因为 paths.js 在加载时就把常量算定了，同一进程内改环境变量已经来不及。
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process')

// 在指定的项目根下解析 paths.js，返回它导出的常量（仅取需要的几项）
function resolveIn(appDir) {
  const script = `
    const P = require(${JSON.stringify(path.join(__dirname, 'paths.js'))});
    process.stdout.write(JSON.stringify({
      DATA_DIR: P.DATA_DIR,
      items: P.DATA_ITEMS.map(function (it) { return it.name }),
      CONFIG_FILE: P.CONFIG_FILE,
      VOICES_JSON: P.VOICES_JSON,
      VOICES_DIR: P.VOICES_DIR,
      BACKUP_DIR: P.BACKUP_DIR,
      RECIPES_DIR: P.RECIPES_DIR,
      FLOWGRAPH_DIR: P.FLOWGRAPH_DIR,
      ADVANCED_PARAMS_FILE: P.ADVANCED_PARAMS_FILE,
      TRAINING_DEFAULTS_FILE: P.TRAINING_DEFAULTS_FILE,
      PRON_LEXICON_DIR: P.PRON_LEXICON_DIR,
    }));
  `
  const env = { ...process.env, AURIVOX_APP_DIR: appDir }
  // 清掉可能干扰判定的逐项覆盖
  for (const k of ['DATA_DIR', 'APP_CONFIG_FILE', 'VOICES_JSON', 'VOICES_DIR',
    'BACKUP_DIR', 'RECIPES_DIR', 'FLOWGRAPH_DIR', 'ADVANCED_PARAMS_FILE',
    'TRAINING_DEFAULTS_FILE', 'PRON_LEXICON_DIR', 'ASSETS_ROOT']) delete env[k]
  const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf-8' })
  return JSON.parse(out)
}

test('全新安装：运行期数据一律落在 data/ 之下，项目根保持干净', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-fresh-'))
  const P = resolveIn(root)
  const data = path.join(root, 'data')

  assert.strictEqual(P.DATA_DIR, data)
  assert.strictEqual(P.CONFIG_FILE, path.join(data, 'app-config.json'))
  assert.strictEqual(P.VOICES_JSON, path.join(data, 'voices.json'))
  assert.strictEqual(P.VOICES_DIR, path.join(data, 'voices'))
  assert.strictEqual(P.BACKUP_DIR, path.join(data, 'backups'))
  assert.strictEqual(P.RECIPES_DIR, path.join(data, 'recipes'))
  assert.strictEqual(P.FLOWGRAPH_DIR, path.join(data, 'flowgraph'))
  assert.strictEqual(P.ADVANCED_PARAMS_FILE, path.join(data, 'advanced_params.json'))
  assert.strictEqual(P.TRAINING_DEFAULTS_FILE, path.join(data, 'training_defaults.json'))
  assert.strictEqual(P.PRON_LEXICON_DIR, path.join(data, 'pron_lexicon'))

  // data/ 必须在加载时就建好：writeConfig 会往里写临时文件
  assert.ok(fs.existsSync(data), 'data/ 应在 paths.js 加载时即创建')

  fs.rmSync(root, { recursive: true, force: true })
})

test('尚未搬迁的既有安装：项目根上已有的数据继续沿用，不会失联', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-legacy-'))
  // 模拟一个只更新了代码、还没跑数据迁移的安装
  fs.writeFileSync(path.join(root, 'voices.json'), '{}')
  fs.mkdirSync(path.join(root, 'recipes'))
  const P = resolveIn(root)

  assert.strictEqual(P.VOICES_JSON, path.join(root, 'voices.json'),
    '根上已有 voices.json 却改读 data/，用户的音色会整批消失')
  assert.strictEqual(P.RECIPES_DIR, path.join(root, 'recipes'),
    '根上已有 recipes/ 却改读 data/，用户的配方会整批消失')
  // 根上没有的，仍按新布局落在 data/
  assert.strictEqual(P.BACKUP_DIR, path.join(root, 'data', 'backups'))

  fs.rmSync(root, { recursive: true, force: true })
})

test('data/ 优先于项目根：手工放进 data/ 的文件立刻生效', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-both-'))
  fs.writeFileSync(path.join(root, 'voices.json'), '{}')
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'data', 'voices.json'), '{}')
  const P = resolveIn(root)
  assert.strictEqual(P.VOICES_JSON, path.join(root, 'data', 'voices.json'),
    '两处都在时应以 data/ 为准，否则迁移过程中会读到旧件')
  fs.rmSync(root, { recursive: true, force: true })
})

test('迁移名录与实际常量不会各说各话', () => {
  const P = require('./paths')
  // DATA_ITEMS 是迁移脚本的依据。它若与常量脱节，迁移就会搬错东西或漏搬。
  const byName = new Map(P.DATA_ITEMS.map((it) => [it.name, it]))
  const expect = {
    'app-config.json': P.CONFIG_FILE,
    'voices.json': P.VOICES_JSON,
    'advanced_params.json': P.ADVANCED_PARAMS_FILE,
    'training_defaults.json': P.TRAINING_DEFAULTS_FILE,
    voices: P.VOICES_DIR,
    backups: P.BACKUP_DIR,
    recipes: P.RECIPES_DIR,
    flowgraph: P.FLOWGRAPH_DIR,
  }
  assert.deepStrictEqual(
    P.DATA_ITEMS.map((it) => it.name).sort(),
    Object.keys(expect).sort(),
    'DATA_ITEMS 与运行期数据常量不再一一对应',
  )
  for (const [name, val] of Object.entries(expect)) {
    const it = byName.get(name)
    assert.strictEqual(path.basename(val), name, `${name} 的常量落点与名录不符`)
    assert.strictEqual(typeof it.isDir, 'boolean', `${name} 缺少 isDir`)
    assert.ok(it.desc && it.env, `${name} 缺少说明或环境变量名`)
  }
})
