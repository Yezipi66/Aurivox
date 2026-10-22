const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('os')

// 项目布局只允许在 lib/paths.js（拆在 lib/paths/ 下）里定义一次。
// 判定方式刻意保持字面且狭窄：只在同时出现 path.join / path.resolve 的行上，
// 检查是否把下列业务目录名写成了字符串字面量。它不做风格评判，只拦截确凿的重复定义。

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
  'tts',
  'uvr5',
  'asr',
  'slicer',
  'gsv-tools',
]

// 豁免清单。每一条都必须写明理由：没有理由的豁免等于没有规则。
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
    'pipeline/uvr5/uvr5_models.js',
    '第三方训练工具目录内的代码，使用相对自身的默认值并接受外部覆盖；'
    + '不应反向依赖应用层的 lib/paths.js。',
  ],
  [
    'lib/routes/voices.platform.node.test.js',
    '在临时目录里搭 voices.json 夹具，写的是夹具内部文件名，与项目布局无关。',
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
      // lib/paths/ 目录是路径权威的拆分实现，等同于 lib/paths.js
      if (e.name === 'paths' && path.basename(dir) === 'lib') continue
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
    'PRETRAINED', 'CACHE', 'OUTPUT_ROOTS', 'RUNTIME_DIRS', 'LEGACY_LOCATIONS', 'DATA_ITEMS',
    // 下面几项是「名字 -> 路径」的表，逐项检查见本测试后半段。
    'BASE_DIRS', 'BASE_WEIGHTS', 'LEGACY_BASE_DIRS',
    'BASE_WEIGHTS_CANONICAL', 'BASE_WEIGHTS_LEGACY',
  ])
  for (const [k, v] of Object.entries(P)) {
    if (skip.has(k)) continue
    assert.strictEqual(typeof v, 'string', `${k} 应为字符串`)
    assert.ok(path.isAbsolute(v), `${k} 应为绝对路径，实际为 ${v}`)
  }
  for (const [k, v] of Object.entries(P.PRETRAINED)) {
    assert.ok(path.isAbsolute(v), `PRETRAINED.${k} 应为绝对路径`)
  }
  for (const table of ['BASE_DIRS', 'BASE_WEIGHTS', 'LEGACY_BASE_DIRS',
    'BASE_WEIGHTS_CANONICAL', 'BASE_WEIGHTS_LEGACY']) {
    for (const [k, v] of Object.entries(P[table])) {
      // BASE_WEIGHTS_LEGACY 里「本来就没搬过」的条目登记为 null。
      if (v === null && table === 'BASE_WEIGHTS_LEGACY') continue
      assert.strictEqual(typeof v, 'string', `${table}.${k} 应为字符串`)
      assert.ok(path.isAbsolute(v), `${table}.${k} 应为绝对路径，实际为 ${v}`)
    }
  }
  for (const [k, v] of Object.entries(P.CACHE)) {
    assert.ok(path.isAbsolute(v), `CACHE.${k} 应为绝对路径`)
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

// 权重与缓存的归属（引擎契约 C8 / C9）：权重一律在 models/ 之下，缓存一律在 cache/ 之下，
// 两者都不进 git。
// 权重目录只允许有一处算法。调用方按 A 拼路径、脚本按 B 找权重，找不到就自己去下载，
// 不报错、只是慢，硬盘上多出一份。这条守卫盯着最容易复发的那个脚本。
test('faster-whisper 权重路径只有一处算法，不得再出现第二套拼法', () => {
  // 路径从 paths.js 取（ASR_DIR），不在这里重拼：本文件自己那条权威守卫
  // 就是禁止这种事的，搬家时重拼的那份会失准。
  const P = require('./paths')
  const src = fs.readFileSync(
    path.join(P.ASR_DIR, 'fasterwhisper_asr.py'), 'utf8');

  const canonical = /os\.path\.join\(asr_models_dir, model_size\)/g;
  assert.equal((src.match(canonical) || []).length, 1,
    '权重目录的唯一算法 <权重根>/<model_size> 必须只出现一次');

  // main() 不得绕过 _get_model_path() 自己在 --model_dir 下面拼子目录。
  assert.ok(!/os\.path\.join\(\s*cmd\.model_dir/.test(src),
    'main() 又在 cmd.model_dir 下面自己拼路径了；应改为调用 _get_model_path()');

  // 找权重时不得给 model_size 加 "faster-whisper-" 前缀（该前缀只属于
  // HuggingFace / ModelScope 的仓库名与仓库内层级，不属于我们的目录布局）。
  for (const m of src.split(/\r?\n/)) {
    if (!/faster-whisper-/.test(m)) continue;
    const isRepoName = /repo_id|files = |nested = |help=|#/.test(m);
    assert.ok(isRepoName,
      `这一行在本地路径里加了 faster-whisper- 前缀，我们的布局不含该前缀：${m.trim()}`);
  }
});

// tts_infer.yaml.example 是那份不进 git 的配置文件的种子：里面的路径写错一次，
// 就会被复制到每台机器上，再被引擎悄悄改掉。测试套件里没有别处会看它。
test('推理配置模板里的每个权重路径都指向 models/，且不含已废弃的版本段', () => {
  const tpl = fs.readFileSync(
    path.join(__dirname, 'inference', 'tts_infer.yaml.example'), 'utf8');

  const lines = tpl.split(/\r?\n/).filter((l) => !l.trim().startsWith('#'));

  for (const l of lines) {
    const m = l.match(/^\s+(\w*_?(?:path|base_path)):\s*(\S+)\s*$/);
    if (!m) continue;
    assert.ok(m[2].startsWith('./models/'),
      `${m[1]} 仍指向 ${m[2]}；权重已迁至 models/，模板必须跟着改`);
  }

  // 只看配置行：注释里提到这些旧目录是在解释为什么废弃，不算残留。
  const body = lines.join('\n');
  for (const dead of ['GPT_SoVITS/pretrained_models', 'vendor/gsv-tools']) {
    assert.ok(!body.includes(dead), `模板里仍残留已不存在的目录 ${dead}`);
  }

  // v3/v4 的权重从未下载过，段里每条路径都指向不存在的目录，属死配置。
  // v1 不在此列：它的两个权重都在盘上，且导入的 v1 模型能被识别。
  for (const dead of ['v3:', 'v4:']) {
    assert.ok(!lines.some((l) => l === dead),
      `模板里仍有 ${dead} 段，但该版本的权重从未下载，加载必然失败`);
  }

  // 底模一版一目录（见 lib/paths.js 的 BASE_DIRS）。模板里 v1 那一节的两个权重
  // 必须都在 v1/ 下：写错目录名的人会以为它们分处别处。
  assert.ok(tpl.includes(
    'v1/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt'),
    'v1 的 GPT 权重应在 v1/ 下');
  assert.ok(tpl.includes('v1/s2G488k.pth'),
    'v1 的 SoVITS 权重应在 v1/ 下');

  // 旧布局的两个目录名不得再出现在模板里：live 的 tts_infer.yaml 是按模板生成的，
  // 模板里留一条旧路径，就会在每台新机器上复制出一份指向空目录的配置。
  // 同样只看配置行：顶部注释里提到 gsv-v2final 是在告诉读者旧布局怎么迁移。
  for (const dead of ['gsv-v2final/', 'gsv-v2final-pretrained/']) {
    assert.ok(!body.includes(dead),
      `模板里仍有旧布局路径 ${dead}；底模已按版本分目录`);
  }
});

test('权重常量全部位于 models/ 之下，且不再指向 vendor/', () => {
  const P = require('./paths')
  const weightKeys = [
    'TTS_MODELS_DIR', 'GSV_PRETRAINED_DIR',
    'ASR_MODELS_DIR', 'FASTER_WHISPER_DIR', 'FUNASR_MODELS_DIR',
    'UVR5_WEIGHTS_DIR', 'VOCODER_DIR', 'SR_MODELS_DIR', 'LANG_MODELS_DIR',
  ]
  const under = (child, parent) =>
    path.resolve(child) === path.resolve(parent) ||
    path.resolve(child).startsWith(path.resolve(parent) + path.sep)

  for (const k of weightKeys) {
    assert.ok(P[k], `${k} 未导出`)
    assert.ok(under(P[k], P.MODELS_DIR), `${k} 不在 models/ 之下：${P[k]}`)
    assert.ok(!under(P[k], P.VENDOR_DIR), `${k} 仍指向 vendor/：${P[k]}`)
  }
  for (const [k, v] of Object.entries(P.PRETRAINED)) {
    assert.ok(under(v, P.MODELS_DIR), `PRETRAINED.${k} 不在 models/ 之下：${v}`)
    assert.ok(!under(v, P.VENDOR_DIR), `PRETRAINED.${k} 仍指向 vendor/：${v}`)
  }
})

test('缓存常量全部位于 cache/ 之下，且不与权重混放', () => {
  const P = require('./paths')
  const under = (child, parent) =>
    path.resolve(child).startsWith(path.resolve(parent) + path.sep)
  for (const [k, v] of Object.entries(P.CACHE)) {
    assert.ok(under(v, P.CACHE_DIR), `CACHE.${k} 不在 cache/ 之下：${v}`)
    assert.ok(!under(v, P.MODELS_DIR), `CACHE.${k} 混进了 models/：${v}`)
    assert.ok(!under(v, P.VENDOR_DIR), `CACHE.${k} 混进了 vendor/：${v}`)
  }
})

test('分离模型的架构目录名不得含有推理代码用于匹配的字样', () => {
  const P = require('./paths')
  // uvr5 的加载器拿路径做子串匹配判定架构（bsroformer.py / vr.py）。
  // 若目录名里出现这些字样，Mel-Band 权重会被判成 BS-Roformer，
  // 而加载器是宽容加载：不报错、能出声、声音是坏的。
  const forbidden = ['bs_roformer', 'bsroformer', 'mel_band_roformer', 'dereverb']
  const lower = P.UVR5_WEIGHTS_DIR.toLowerCase()
  for (const word of forbidden) {
    assert.ok(!lower.includes(word), `UVR5_WEIGHTS_DIR 含有会被误匹配的字样「${word}」：${P.UVR5_WEIGHTS_DIR}`)
  }
})

// 项目根的判定：跟随入口 server.js，而不是本文件所在的位置。
// lib/ 可能是指向别处的符号链接（测试环境 brokerHarness.js 就是这么搭的），
// 此时 paths.js 的 __dirname 会落在被链接的那份仓库里。若拿它的上一级当项目根，
// 服务端就会去错误的目录读写 voices.json 等运行期文件，表现为音色一律查不到（404）。
// 这条测试锁死判定逻辑，防止再次退化。

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
  // 这些文件现在挂在 data/ 下，但必须位于项目根之内：若哪天落到 lib/ 下面，
  // 或落到项目之外，既有安装的数据就会失联。
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

// 运行期数据迁入 data/ 后，下面几条测试都在临时目录里另起一个 node 进程来解析路径。
// 必须另起进程：paths.js 在加载时就把常量算定了，同一进程内改环境变量已经来不及。

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

// 读一个 PowerShell 脚本并剥掉注释，只留可执行文本。
// 判定前必须去掉注释：只凭注释里的一句话就能让一条按文本匹配的守卫通过，
// 把实现改成另一种写法也不会红。
function readScript(name) {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'tools', 'scripts', name), 'utf8')
  return raw
    .split('\n')
    .filter((ln) => !/^\s*#/.test(ln))
    .map((ln) => ln.replace(/\s+#(?![^']*').*$/, ''))
    .join('\n')
}

// 引擎活动配置的自检自修在 lib/inference/config_repair.py 里，
// 它的判据由 lib/inference/configRepair.node.test.js 真跑 Python 验证。

// 停止有两遍：「没在监听」不等于「没在运行」（掉了监听器但还活着的进程仍然锁着文件）；
// 第二遍必须排除脚本自己，并且按可执行文件是否在项目内判定，不按命令行
// （比命令行会连用户的 shell 一起杀掉）；项目根靠上溯找 package.json 定位，不按目录层数倒推。
// 行为那半由 lib/system/ports.node.test.js 真起进程验证，这里只守 stop.js 的接线。
test('停止脚本不把「没在监听」当成「没在运行」（第二遍接线还在）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'cli', 'stop.js'), 'utf8')

  // 第一遍：按端口
  assert.match(src, /listenersOnPort\(/,
    '停止脚本没有按端口查的那一遍')
  // 第二遍：按项目目录找残留：这一遍是本条守卫的主体
  assert.match(src, /procsUnderDir\(/,
    '缺少按可执行文件位置兜底的第二遍查找')
  // 项目根靠上溯找 package.json，不按层数倒推
  assert.match(src, /package\.json/,
    '项目根必须靠上溯找 package.json 定位')
  assert.ok(!/\.\.\\\.\.\\\.\./.test(src),
    '出现了数目录层数的写法 —— 本文件被搬过，数层级会一直「能用」却指着别处')
  // 进程表要有 TTL 缓存，否则起来之后新起的进程看不见（第二遍就白做）
  assert.match(src, /clearProcsCache\(/,
    '停止脚本没有清进程表缓存 ⇒ 起来之后新起的进程在第二遍里查不到')
})

test('第二遍只按可执行文件路径判定，不按命令行', () => {
  // 行为在 lib/system/ports.node.test.js 里真起进程验证了；
  // 这里守的是默认参数没被改成比命令行。
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'system', 'ports.js'), 'utf8')
  assert.match(src, /function procsUnderDir \(dir, \{ matchCmdline = false \} = \{\}\)/,
    'procsUnderDir 的默认收窄变了。⚠️ 默认只比可执行文件路径是有原因的：'
    + '命令行里含仓库路径的东西包括用户那个「cd 到项目目录再运行 stop」的 shell，'
    + '比命令行就会把用户的 shell 杀掉')
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
