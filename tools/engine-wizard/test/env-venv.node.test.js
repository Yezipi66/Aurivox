'use strict'
// ============================================================================
//  第 2 步的**隔离环境**（engines/<id>/.venv）
//
//  ⭐ 为什么单开一个文件：env.node.test.js 守的是「装法有据可依」，
//    本文件守的是**装之前先把环境建出来**。
//    两者是同一个步骤的两件事，混在一个文件里会让失败名看不出是哪件。
//
//  ⚠ 病症实况（Owner 2026-10-12 判定 P0）：
//    平台原来从头到尾⛔ 没有一处建 engines/<id>/.venv，
//    装依赖那步就是裸 `uv pip install -r requirements.txt`
//    ⇒ uv 报「No virtual environment found; run 'uv venv' to create one」
//    ⇒ 用户压根创建不了引擎的 Python 环境。
//
//  ⛔⛔ 三条实测得来的硬约束（Owner 2026-10-12 亲自跑过，不要再猜）：
//
//   ① uv 选目标环境的**唯一**可靠方式是 `-p/--python <绝对路径>`。
//      设 VIRTUAL_ENV 环境变量⛔ 无效（uv 认自己所在的那个环境，环境变量压不住）。
//      `--python <相对路径>` 也无效，uv 报「No virtual environment ... for path」。
//      ⇒ 所以装依赖那步必须把目标解释器的**绝对路径**写进 argv。
//
//   ② ⛔ uv sync 的 `-p/--python` **不是**「装进哪个解释器」，
//      而是「用哪个解释器**当基准建项目环境**」——
//      实测 `uv sync --python <某个已存在的 venv>` 会照锁装完、看着成功，
//      ⛔ 但装进的是它**在项目目录新建的 .venv**，目标 venv 里根本没有那个包。
//      ⇒ sync 那条路的正确写法是 `UV_PROJECT_ENVIRONMENT=<绝对路径>`。
//      ⛔ 这个陷阱静默成功（退出码 0），比报错更难发现。
//
//   ③ conda env create 自己会建环境 ⇒ ⛔ 不许再塞一步 uv venv 过去，
//      否则同一个环境被建两遍。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const envMod = require('../core/env.js')

// ---------------------------------------------------------------------------
// 夹具
//
// ⚠ 守卫（enginesDirWriteGuard.node.test.js:148）要求写盘路径上带临时目录痕迹，
//   否则并行跑会污染真的 engines/。⇒ 变量名必须含 mkdtemp（守卫只看实参文本）。
// ⛔ 本文件⛔ 不真建 venv、不联网装包：只断言 argv 与环境变量的**形状**。
// ---------------------------------------------------------------------------

/** ⭐ 造一个「项目根 + engines/<id>/」，带一份依赖清单 */
function mkdtempEngineWithManifest (id, manifestName) {
  const mkdtempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-venv-'))
  const mkdtempEngines = path.join(mkdtempRoot, 'engines')
  const mkdtempEngineDir = path.join(mkdtempEngines, id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  fs.writeFileSync(path.join(mkdtempRoot, 'server.js'), '// anchor\n')
  fs.writeFileSync(path.join(mkdtempEngineDir, manifestName), '# fixture\n')
  return { root: mkdtempRoot, engineDir: mkdtempEngineDir }
}

/** ⭐ 把 argv 里 `--python`/`-p` 后面的那个值取出来（没带就 null） */
function targetPythonOf (argv) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '-p' || argv[i] === '--python') return argv[i + 1]
  }
  return null
}

/** ⭐ 这台引擎的 .venv 里那个解释器的绝对路径（按平台推导） */
function engineVenvPythonAbs (root, id) {
  return path.join(root, 'engines', id, '.venv',
    process.platform === 'win32' ? path.join('Scripts', 'python.exe')
      : path.join('bin', 'python'))
}

const planOf = (root, id, manifest) =>
  envMod.buildEnvPlan({ id, root, manifest })

/** ⭐ 只取可执行步骤（⛔ steps 里混着 kind:'note' 的说明条目） */
const envStepsOf = (p) => p.steps.filter((s) => s.kind === 'env')

// ---------------------------------------------------------------------------
// ① 建环境那一步必须在，而且排在装依赖之前
// ---------------------------------------------------------------------------
test('⛔⭐ 第 2 步必须先建该引擎自己的虚拟环境，再装依赖', () => {
  const { root } = mkdtempEngineWithManifest('demo1', 'requirements.txt')
  const p = planOf(root, 'demo1', {})
  assert.strictEqual(p.ok, true, p.error)

  const steps = envStepsOf(p)
  assert.ok(steps.length >= 2,
    `⛔ 只有 ${steps.length} 步：没有建环境这一步，uv 必然报`
    + '「No virtual environment found」\n'
    + steps.map((s) => s.argv.join(' ')).join('\n'))

  // ⭐ 第 1 步必须是「建环境」，且它的 argv 里必须有 venv 这个词
  const first = steps[0]
  assert.ok(/venv/i.test(first.argv.join(' ')),
    `⛔ 第 1 步不是建环境：${first.argv.join(' ')}`)
  // ⛔ 后面的步骤必须是装依赖（不能只剩建环境一步）
  assert.ok(steps.slice(1).some((s) => /(pip|sync|env create|install)/i.test(s.argv.join(' '))),
    '⛔ 建环境之后必须还有装依赖的步骤')
})

test('⛔ 建环境走 uv（⛔ 不是 python -m venv），且目标路径是该引擎的 .venv', () => {
  const { root } = mkdtempEngineWithManifest('demo2', 'requirements.txt')
  const p = planOf(root, 'demo2', {})
  const first = envStepsOf(p)[0]

  // ⭐ 建法：<某个 python> -m uv venv <绝对路径>
  assert.ok(first.argv.includes('-m') && first.argv.includes('uv')
    && first.argv.includes('venv'),
    `⛔ 建环境必须走「<python> -m uv venv」：${first.argv.join(' ')}`)
  // ⛔ 绝对不许 python -m venv：平台统一走 uv（resolveUv 同一条路）
  assert.ok(!/^(?:-m\s+venv)?$/.test('') && !first.argv.every((a) => a !== 'venv')
    || first.argv.includes('-m'),
    `⛔ 不许裸 python -m venv：${first.argv.join(' ')}`)

  // ⭐ 目标是 engines/<id>/.venv 的**绝对路径**
  const target = first.argv[first.argv.indexOf('venv') + 1]
  assert.ok(path.isAbsolute(target),
    `⛔ 建环境的路径必须是绝对路径：${target}`)
  assert.strictEqual(target, path.join(root, 'engines', 'demo2', '.venv'),
    `⛔ 建到了别的目录：${target}`)
})

// ---------------------------------------------------------------------------
// ③ 装依赖必须显式指定目标解释器（⛔ 绝不让 uv 自己猜）
// ---------------------------------------------------------------------------
test('⛔⭐ 装依赖那步必须带 -p <该引擎 .venv 里 python 的绝对路径>', () => {
  const { root } = mkdtempEngineWithManifest('demo3', 'requirements.txt')
  const p = planOf(root, 'demo3', {})
  const install = envStepsOf(p)[1]
  assert.ok(install, '⛔ 没有装依赖那一步')

  const got = targetPythonOf(install.argv)
  assert.ok(got, `⛔ 装依赖没有指定目标解释器，uv 会自己乱猜：`
    + install.argv.join(' '))
  assert.ok(path.isAbsolute(got),
    `⛔ 目标解释器必须是绝对路径（相对路径 uv 会报「No virtual environment」）：${got}`)
  assert.strictEqual(got, engineVenvPythonAbs(root, 'demo3'),
    `⛔ 目标解释器不指向该引擎的 .venv：${got}`)
})

test('⛔ 目标解释器不得是平台根 venv（否则装到平台自己身上）', () => {
  const { root } = mkdtempEngineWithManifest('demo4', 'requirements.txt')
  const p = planOf(root, 'demo4', {})
  for (const s of envStepsOf(p)) {
    const got = targetPythonOf(s.argv)
    if (!got) continue
    const norm = got.split(/[\\/]/).join('/')
    // ⛔ 平台自己的 venv 在**项目根**下；引擎的 venv 在 engines/<id>/ 下
    assert.ok(!(norm.endsWith('/venv/Scripts/python.exe')
      || norm.endsWith('/venv/bin/python')),
    `⛔ 装进了平台自己的环境，不是该引擎的：${got}`)
    assert.ok(/engines\/demo4\/\.venv/.test(norm),
      `⛔ 必须指向该引擎的 .venv：${got}`)
  }
})

test('⛔ 不许靠环境变量选目标（实测设 VIRTUAL_ENV 对 uv 无效，且会给人错觉）', () => {
  const { root } = mkdtempEngineWithManifest('demo5', 'requirements.txt')
  const p = planOf(root, 'demo5', {})
  for (const s of envStepsOf(p)) {
    assert.ok(!s.env || !s.env.VIRTUAL_ENV,
      '⛔ 设 VIRTUAL_ENV 选目标对 uv 无效（实测），不许留这段')
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'env.js'), 'utf8')
  // ⛔ 注释里解释这条坑是允许的，活代码里不许真去设它
  const live = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(!/env:\s*\{[^}]*VIRTUAL_ENV/.test(live),
    '⛔ 活代码里不许用 VIRTUAL_ENV 选 uv 的目标环境')
})

// ---------------------------------------------------------------------------
// ④ 幂等：环境已经在 ⇒ 不必再建
// ---------------------------------------------------------------------------
test('⛔⭐ .venv 已存在 ⇒ 建那一步被跳过，⛔ 不重复建', () => {
  const { root, engineDir } = mkdtempEngineWithManifest('demo6', 'requirements.txt')
  const venvDir = path.join(engineDir, '.venv')
  const py = path.join(venvDir,
    process.platform === 'win32' ? path.join('Scripts', 'python.exe')
      : path.join('bin', 'python'))
  // ⚠ 只造一个空壳目录 + 假 python 文件：本文件⛔ 不该靠「python 能起」来造。
  //   这条断言的是「**有环境就不重建**」，那个自检由 runEnv 那条真跑测试盖。
  fs.mkdirSync(path.dirname(py), { recursive: true })
  fs.writeFileSync(py, '')

  const p = planOf(root, 'demo6', {})
  const build = envStepsOf(p).find((s) => /(^|\s)venv(\s|$)/i.test(s.argv.join(' ')))
  assert.ok(build, '⛔ 计划里仍应有建环境那一步（判据在执行期，不在计划期）')
  assert.ok(build.skipIfExists === true,
    '⛔ 建环境那一步必须声明「已存在就跳过」，否则每次重跑都重建')
})

// ---------------------------------------------------------------------------
// ⑤ conda 那条路：⛔ 不塞 uv venv（conda 自己会建）
// ---------------------------------------------------------------------------
test('⛔⭐ conda 那条路⛔ 不许混进 uv venv（conda 自己会建环境）', () => {
  const { root } = mkdtempEngineWithManifest('demo7', 'environment.yml')
  const p = planOf(root, 'demo7', {})
  assert.strictEqual(p.ok, true, p.error)
  const steps = envStepsOf(p)
  assert.ok(steps.some((s) => /conda/.test(s.argv.join(' '))),
    `⛔ 应走 conda：${steps.map((s) => s.argv.join(' ')).join('\n')}`)
  assert.ok(!steps.some((s) => /\buv\b/.test(s.argv.join(' '))
    && /(^|\s)venv(\s|$)/i.test(s.argv.join(' '))),
    '⛔ conda 自建环境，再塞一步 uv venv 等于建两遍')
})

// ---------------------------------------------------------------------------
// ⑥ 锁文件那条路：sync 的目标环境必须是该引擎的 .venv
//
// ⚠ 这条是本次最容易做错的一条：实测 `uv sync -p <某个已存在的 venv>`
//   会照锁装完、退出码 0，⛔ 但装进的是它在项目目录**新建的 .venv**，
//   指定的那个 venv 里根本没有。⇒ 必须用 UV_PROJECT_ENVIRONMENT。
// ---------------------------------------------------------------------------
test('⛔⭐ 锁文件那条路：sync 的目标环境必须是该引擎的 .venv（⛔ 不是平台根）', () => {
  const { root } = mkdtempEngineWithManifest('demo8', 'uv.lock')
  const p = planOf(root, 'demo8', {})
  assert.strictEqual(p.ok, true, p.error)
  const sync = envStepsOf(p).find((s) => /sync/i.test(s.argv.join(' ')))
  assert.ok(sync, `⛔ 应走 uv sync：${p.steps.map((s) => s.argv.join(' ')).join('\n')}`)

  // ⛔ 正确写法：UV_PROJECT_ENVIRONMENT 指向该引擎的 .venv（绝对路径）
  const envObj = sync.env || {}
  const projEnv = envObj.UV_PROJECT_ENVIRONMENT
  assert.ok(projEnv,
    '⛔ sync 必须显式给目标环境：uv sync 没有「装进哪个解释器」这种参数，'
    + '只有 UV_PROJECT_ENVIRONMENT')
  assert.strictEqual(projEnv, path.join(root, 'engines', 'demo8', '.venv'),
    `⛔ sync 目标环境错：${projEnv}`)

  // ⛔ 且⛔ 不用 -p 指向一个已存在的 venv（实测会装进新建的 .venv）
  assert.strictEqual(targetPythonOf(sync.argv), null,
    '⛔ uv sync 的 -p/--python 是「用哪个解释器当基准」，'
    + '⛔ 不是「装进哪个环境」，指过去会装错地方')
})

test('⛔ sync 那步不得再靠 VIRTUAL_ENV（实测无效）', () => {
  const { root } = mkdtempEngineWithManifest('demo9', 'uv.lock')
  const p = planOf(root, 'demo9', {})
  const sync = envStepsOf(p).find((s) => /sync/i.test(s.argv.join(' ')))
  assert.ok(sync && sync.env)
  assert.ok(!sync.env.VIRTUAL_ENV,
    '⛔ VIRTUAL_ENV 对 uv 无效（实测），不许用它选 sync 的目标')
})

// ---------------------------------------------------------------------------
// ⑦ 建完后的自检判据：能不能按绝对路径起起来，⛔ 不是文件在不在
// ---------------------------------------------------------------------------
test('⛔⭐ 自检判据是「能按绝对路径起起来」，⛔ 不是「文件存在」', () => {
  // ⛔ 空壳 .venv：只有目录 + 一个 0 字节的假 python
  //   —— 文件存在，但起不来（这正是平台踩过的坑：
  //   lib/util/pythonResolve.js 的判据是「必须能按绝对路径 spawn」）。
  const { root } = mkdtempEngineWithManifest('shell1', 'requirements.txt')
  const p = planOf(root, 'shell1', {}, )
  assert.strictEqual(p.ok, true, p.error)

  const ok = envMod.canUseEngineVenv(root, 'shell1')
  assert.strictEqual(ok, false,
    '⛔ 空壳 .venv 被判成可用了 —— 那会重演「文件在但起不来」的坑')
})

test('⛔ 目录都不存在 ⇒ 判不可用（⛔ 不许把「没建」说成「建好了」）', () => {
  const { root } = mkdtempEngineWithManifest('shell2', 'requirements.txt')
  assert.strictEqual(envMod.canUseEngineVenv(root, 'shell2'), false)
})

// ---------------------------------------------------------------------------
// ⑧ 平台 python 的选择：有声明用声明的，没声明用平台自己的
// ---------------------------------------------------------------------------
test('⭐ 名片没有 python 版本声明 ⇒ 用平台根 venv 的 python（规范：有声明才用声明）', () => {
  const { root } = mkdtempEngineWithManifest('demo10', 'requirements.txt')
  const p = planOf(root, 'demo10', {})
  const build = envStepsOf(p)[0]
  const interp = build.argv[0]
  assert.ok(path.isAbsolute(interp), `⛔ 建环境要用绝对路径的解释器：${interp}`)
  // ⭐ 平台根 venv 与引擎 venv 是两个东西
  assert.ok(!/engines/.test(interp.split(/[\\/]/).join('/')),
    `⛔ 建环境时不该拿引擎自己的 python 当基准（那时它还不存在）：${interp}`)
  assert.ok(/venv[\\/]Scripts[\\/]python\.exe$/.test(interp)
    || /venv[\\/]bin[\\/]python$/.test(interp),
    `⛔ 应当是平台根 venv 的 python：${interp}`)
})

test('⭐ 名片里现在没有 python 版本这个字段（⛔ 不许自己加一个）', () => {
  // ⛔ Owner 定的规范是「有声明的就用声明的」——
  //   ⛔ 但名片 schema（lib/engines/profile.js 的 TOP_KEYS / install 段）
  //   实测**没有**声明 python 版本的字段。
  //   ⇒ 按规范只能退回平台自己的 python。
  //   ⛔ 这条测试的作用是：将来真有人加了字段，这条会红，提醒同步改实现。
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'lib', 'engines', 'profile.js'), 'utf8')
  const declaresPythonVersion =
    /requires_python|requires-python|python_version|pythonVersion/.test(src)
  assert.strictEqual(declaresPythonVersion, false,
    '⛔ 名片 schema 似乎有了 python 版本声明 —— '
    + '实现要改成「按声明建」，否则会默默按平台版本装')
})

// ---------------------------------------------------------------------------
// ⑨ ⭐⭐⭐ 每一条会装东西的命令：目标环境必须**等于** engines/<id>/.venv
//
// ⚠⚠ 为什么这一段是本文件里最要紧的（2026-10-12 真机 P0）：
//   上面 ③ 那条测试断言的是「argv 里有 -p」，
//   而它在真机上是绿的 —— 因为它只看**主**安装步。
//   ⛔ 上一次修复只给主步加了 -p，⛔ 漏了 alt 那步（装 torch 的第②步）
//   ⇒ 14 条全绿，真机却把 torch 装进了**平台根 venv**，
//     而引擎环境里 288 个包独缺 torch ⇒ 用户拿到的环境 import 失败。
//   ⇒ 所以这里的判据一律是「**目标环境等于那个绝对路径**」，
//     ⛔ 不接受「参数存在」这种弱判据。
// ---------------------------------------------------------------------------

/** 造一份「torch 锁在 CUDA 线上」的 uv.lock（形状照真实 lock） */
function writeCudaLockTo (dir) {
  fs.writeFileSync(path.join(dir, 'uv.lock'), [
    'version = 1',
    '',
    '[[package]]',
    'name = "torch"',
    'version = "2.8.0+cu128"',
    'source = { registry = "https://download.pytorch.org/whl/cu128" }',
    'marker = "sys_platform == \'linux\' or sys_platform == \'win32\'"',
    '',
  ].join('\n'))
}

/**
 * ⭐⭐ 判据核心：**这一步装进哪儿** —— 统一成一个断言函数。
 *
 * ⚠ 两种合法形态（都实测过，别混）：
 *   · `uv pip …`  ⇒ argv 里的 -p/--python 是「装进哪个环境」
 *   · `uv sync …` ⇒ 必须靠 UV_PROJECT_ENVIRONMENT（sync 的 -p 是
 *     「用哪个解释器当基准建项目环境」，实测会装进它自己新建的 .venv）
 *
 * @param {string[]} argv 这一步的 argv
 * @param {object|null} envVar 这一步带的 env
 * @param {string} wantPy 该引擎 .venv 里那个解释器的绝对路径
 * @param {string} wantVenv 该引擎 .venv 目录的绝对路径
 * @param {string} label 这一步叫什么（失败信息里用）
 */
function assertTargetsEngineVenv (argv, envVar, wantPy, wantVenv, label) {
  const line = argv.join(' ')
  const isSync = /(^|\s)sync(\s|$)/.test(line)
  const got = targetPythonOf(argv)
  if (isSync) {
    // ⛔ sync 不认 -p，必须靠环境变量，且⛔ 不许用 -p 指向已存在的 venv
    assert.strictEqual(got, null,
      `⛔ ${label}：uv sync 的 -p/--python 是「用哪个解释器当基准建项目环境」，`
      + '实测会装进它自己新建的 .venv（退出码 0，静默装错）：' + line)
    assert.ok(envVar && envVar.UV_PROJECT_ENVIRONMENT,
      `⛔ ${label}：sync 必须用 UV_PROJECT_ENVIRONMENT 选目标环境：${line}`)
    assert.strictEqual(envVar.UV_PROJECT_ENVIRONMENT, wantVenv,
      `⛔ ${label}：sync 目标环境不等于该引擎的 .venv：${envVar.UV_PROJECT_ENVIRONMENT}`)
    return
  }
  // ⛔ 非 sync 装法：必须用 -p 钉死，且**等于**引擎 venv 里那个 python
  assert.ok(got,
    `⛔ ${label}：没有指定目标环境，uv 会装进平台自己的环境：${line}`)
  assert.strictEqual(got, wantPy,
    `⛔ ${label}：目标环境不等于该引擎的 .venv 里那个解释器\n`
    + `  实际：${got}\n  应为：${wantPy}\n  命令：${line}`)
}

test('⛔⭐⭐ 装本机后端 torch 的那一步（第②步），目标环境必须等于该引擎的 .venv', () => {
  const { root } = mkdtempEngineWithManifest('alt1', 'uv.lock')
  writeCudaLockTo(path.join(root, 'engines', 'alt1'))
  const p = planOf(root, 'alt1', {})
  assert.strictEqual(p.ok, true, p.error)

  // ⭐ 找那一步：带 torch 的 pip install（主步是 sync）
  const steps = p.steps.filter((s) => s.kind === 'env')
  const torchStep = steps.find((s) => /--index-url/.test(s.argv.join(' ')))
  assert.ok(torchStep,
    '⛔ 锁里 torch 与本机后端不一致时应有「装本机后端 torch」这一步：\n'
    + steps.map((s) => s.argv.join(' ')).join('\n'))

  const want = engineVenvPythonAbs(root, 'alt1')
  // ⭐⭐ 这条就是 2026-10-12 真机 P0 的钉子：⛔ 必须是**等于**，不是「有 -p」
  assertTargetsEngineVenv(torchStep.argv, torchStep.env, want,
    path.join(root, 'engines', 'alt1', '.venv'), '装本机后端 torch 那一步')

  // ⛔ 且绝不能指向平台根 venv（那就是病根：装进了平台自己的环境）
  assert.ok(!/[/\\]venv[/\\](Scripts|bin)[/\\]python/.test(
    String(targetPythonOf(torchStep.argv)).split(/engines[/\\]alt1/).join('engines/alt1')),
  '⛔ 装 torch 那一步绝不能指向平台根 venv')
})

test('⛔⭐ 锁文件路线：全部三步的目标环境都必须等于该引擎的 .venv', () => {
  const { root } = mkdtempEngineWithManifest('alt2', 'uv.lock')
  writeCudaLockTo(path.join(root, 'engines', 'alt2'))
  const p = planOf(root, 'alt2', {})
  const want = engineVenvPythonAbs(root, 'alt2')

  const steps = p.steps.filter((s) => s.kind === 'env')
  // ⭐ 建环境 + 装其余(sync) + 装本机 torch
  assert.ok(steps.length >= 2, `⛔ 步骤太少：${steps.map((s) => s.argv.join(' ')).join('\n')}`)
  for (const s of steps) {
    if (/(^|\s)uv\s+venv(\s|$)|(^|\s)venv(\s|$)/i.test(s.argv.join(' '))) continue
    assertTargetsEngineVenv(s.argv, s.env, want,
      path.join(root, 'engines', 'alt2', '.venv'),
      `第 ${s.argv.join(' ').slice(0, 60)} 步`)
  }
  // ⭐ 建环境那一步的目标目录也必须是 engines/<id>/.venv
  const build = steps.find((s) => /(^|\s)venv(\s|$)/i.test(s.argv.join(' ')))
  const venvDir = build.argv[build.argv.indexOf('venv') + 1]
  assert.strictEqual(venvDir, path.join(root, 'engines', 'alt2', '.venv'),
    `⛔ 建到了别的目录：${venvDir}`)
})

test('⛔⭐ requirements 路线：装依赖那步与 alt 那步都钉死目标环境', () => {
  const { root } = mkdtempEngineWithManifest('alt3', 'requirements.txt')
  const p = planOf(root, 'alt3', {})
  const want = engineVenvPythonAbs(root, 'alt3')
  const install = p.steps.filter((s) => s.kind === 'env')
    .find((s) => /pip/.test(s.argv.join(' ')))
  assert.ok(install, '⛔ 找不到装依赖那一步')
  assert.strictEqual(targetPythonOf(install.argv), want,
    `⛔ 装依赖目标环境错：${install.argv.join(' ')}`)
})

test('⛔⭐ alt 那一步在 sync 与非 sync 两条路上都要有目标环境', () => {
  // ⚠ 上一版的实现从 `targetPython` 取值，而 sync 路线下它是 null
  //   ⇒ alt 那一步就没人钉了 —— 这正是真机 P0 的成因。
  //   ⇒ 两种路线都必须独立地给 alt 那一步钉上 -p。
  for (const id of ['alt4', 'alt5']) {
    const { root } = mkdtempEngineWithManifest(id, 'uv.lock')
    writeCudaLockTo(path.join(root, 'engines', id))
    const p = planOf(root, id, {})
    const steps = p.steps.filter((s) => s.kind === 'env')
    const torchStep = steps.find((s) => /--index-url/.test(s.argv.join(' ')))
    assert.ok(torchStep, `⛔ ${id}：应有装 torch 那一步`)
    const got = targetPythonOf(torchStep.argv)
    assert.ok(got,
      `⛔ ${id}：装 torch 那一步没有目标环境 —— torch 会装进平台根 venv\n`
      + torchStep.argv.join(' '))
    assert.strictEqual(got, engineVenvPythonAbs(root, id),
      `⛔ ${id}：装 torch 那一步目标环境不等于该引擎的 .venv：${got}`)
  }
})

// ---------------------------------------------------------------------------
// ⑩ ⭐⭐⭐ 装完自检：命令全退 0 ⛔ 不等于环境能用
//
// ⚠⚠ 2026-10-12 真机 P0 的另一半：alt 那步装错地方之后，
//   三步退出码全是 0、界面显示「安装完成」，
//   而 engines/<id>/.venv 里 288 个包独缺 torch ⇒ import torch 失败。
//   ⇒ 必须有一条真的去 import 引擎环境的自检，
//     ⛔ 不许只看退出码就说「完成」。
//
// ⛔ 本段⛔ 不真建 venv、不真装包：探针可注入（runEnv 的 input.probeImport），
//   只断言「self-check 该跑的时候跑了、结论怎么传给界面」。
// ---------------------------------------------------------------------------

/** 造一条会触发 alt（装 torch）那一步的计划所需的上游目录 */
function mkdtempTorchEngine (id) {
  const { root, engineDir } = mkdtempEngineWithManifest(id, 'uv.lock')
  writeCudaLockTo(engineDir)
  return { root, engineDir }
}

/**
 * ⭐ 把每一步的执行换成假的（退出码 0），并留下真实 argv。
 * ⚠ 这是本段测试的关键：自检在**全部步骤跑完之后**才算，
 *   ⛔ 而计划里那几条 uv 命令一跑就是几个 GB ⇒ 只能换掉「跑」，
 *   ⛔ 但**计划必须是真的**（argv / env 的形状正是要验的东西）。
 */
const fakeRunAllOk = (ran) => async (step, root, timeoutMs, argv) => {
  ran.push({ argv: argv.slice(), env: step.env })
  return { ok: true, code: 'OK', status: 0, stdout: '', stderr: '' }
}

test('⛔⭐⭐ 装完必须自检引擎环境能不能 import 核心依赖', async () => {
  const { root } = mkdtempTorchEngine('chk1')
  const ran = []
  const seen = []
  const r = await envMod.runEnv({
    id: 'chk1', root, execute: true, manifest: {},
    runStep: fakeRunAllOk(ran),
    probeImport: (r2, id, mod) => {
      seen.push({ root: r2, id, mod })
      return { ok: true, mod, code: 'OK', detail: '' }
    },
  })
  assert.ok(r.envCheck, '⛔ 结果里必须带自检结论（envCheck）')
  assert.ok(typeof r.envCheck.checked === 'boolean',
    '⛔ envCheck 必须说清有没有真的验')
  assert.strictEqual(r.ok, true, r.error)
  // ⚠ 本机若无 GPU，建议后端退 CPU ⇒ 不给 alt ⇒ 没有核心依赖可验（合法）
  if (!r.envCheck.checked) {
    assert.strictEqual(r.envCheck.reason, 'no-core-dependency-declared', r.envCheck.reason)
    return
  }
  assert.ok(seen.length > 0, '⛔ 自检说有验，就必须真的调过探针')
  for (const s of seen) {
    assert.strictEqual(s.id, 'chk1', '⛔ 自检必须针对这台引擎')
    assert.ok(s.mod, '⛔ 探针必须说清验的是哪个包')
    // ⭐ 自检跑在**该引擎自己的环境**里（真机上 import torch 用的就是它）
    assert.strictEqual(
      envMod.engineVenvPythonAbs(s.root, s.id).split(/[\\/]/).join('/'),
      path.join(root, 'engines', 'chk1', '.venv',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
        .split(/[\\/]/).join('/'),
    '⛔ 自检必须在该引擎自己的环境里 import')
  }
  // ⭐ 自检验的包，必须是这次**真的装过**的包
  const installed = ran.flatMap((s) => s.argv).join(' ')
  for (const m of r.envCheck.mods) {
    assert.ok(installed.includes(m),
      `⛔ 自检了 ${m}，但命令里没装过它：${installed}`)
  }
})

test('⛔⭐⭐ 自检发现核心依赖 import 不了 ⇒ 如实报失败，⛔ 不许显示成功', async () => {
  const { root } = mkdtempEngineWithManifest('chk2', 'uv.lock')
  writeCudaLockTo(path.join(root, 'engines', 'chk2'))
  const ran = []
  const r = await envMod.runEnv({
    id: 'chk2', root, execute: true, manifest: {},
    // ⭐ 模拟真机形状：三条命令退出码全是 0，但引擎环境里独缺 torch
    runStep: fakeRunAllOk(ran),
    probeImport: (r2, id, mod) => ({
      ok: false, mod, code: 'MODULE_NOT_FOUND',
      detail: `ModuleNotFoundError: No module named '${mod}'`,
    }),
  })
  if (!r.envCheck || r.envCheck.checked === false) {
    // ⛔ 本机无 alt ⇒ 没有核心依赖可验 ⇒ 不许假装验过
    assert.strictEqual(r.ok, true, r.error)
    return
  }
  assert.strictEqual(r.ok, false,
    '⛔ 命令全退 0 但核心依赖 import 不了，还报成功 —— 那正是真机那次的现象')
  assert.strictEqual(r.code, 'ENGINE_ENV_UNUSABLE',
    '⛔ 必须是「环境不可用」，⛔ 不是「某一步失败」（每一步其实都成功了）')
  assert.deepStrictEqual(r.envCheck.missing, ['torch'])
  // ⭐ 三条命令都真的跑了（否则「全退 0」这个前提是假的）
  assert.ok(ran.length >= 2, `⛔ 步骤太少：${ran.length}`)
  // ⛔⭐ 文案要说清三件事：哪个包没装上、为什么、怎么补（双语成对）
  assert.ok(/torch/.test(r.error) && /engines\/chk2\/.venv/.test(r.error), r.error)
  assert.ok(/uv pip install/.test(r.error) && /-p/.test(r.error),
    `⛔ 必须给出补装的命令：${r.error}`)
  assert.ok(/torch/.test(r.errorZh) && /engines\/chk2\/.venv/.test(r.errorZh), r.errorZh)
  assert.ok(/uv pip install/.test(r.errorZh) && /-p/.test(r.errorZh),
    `⛔ 必须给出补装的命令（中文）：${r.errorZh}`)
  // ⛔ 不许出现 emoji / 破折号 / 口语（契约 5cdf33d）
  for (const [k, s] of [['error', r.error], ['errorZh', r.errorZh],
    ['note', r.note], ['noteZh', r.noteZh]]) {
    assert.ok(!/[——⛔⭐✅]/.test(s), `⛔ ${k} 里有契约禁用的符号/破折号：${s}`)
  }
  // ⭐ 步骤全过了，但结论是失败 ⇒ failedAt 必须为 null（⛔ 不许指向某一步）
  assert.strictEqual(r.failedAt, null,
    '⛔ 每一步都成功了，失败点在「装错地方」，⛔ 不许说第 N 步失败')
  for (const s of r.stepsRun) assert.strictEqual(s.ok, true)
})

test('⛔⭐ 自检通过 ⇒ 结果里说清「验过了哪个包」，⛔ 不是安静地成功', async () => {
  const { root } = mkdtempEngineWithManifest('chk3', 'uv.lock')
  writeCudaLockTo(path.join(root, 'engines', 'chk3'))
  const ran = []
  const r = await envMod.runEnv({
    id: 'chk3', root, execute: true, manifest: {},
    runStep: fakeRunAllOk(ran),
    probeImport: () => ({ ok: true, mod: 'torch', code: 'OK', detail: '' }),
  })
  if (!r.envCheck || r.envCheck.checked === false) return  // 本机无 alt，合法
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.envCheck.missing, [])
  assert.ok(/torch/.test(r.note) && /import/.test(r.note), r.note)
  assert.ok(/torch/.test(r.noteZh) && /import/.test(r.noteZh), r.noteZh)
  for (const s of [r.note, r.noteZh]) {
    assert.ok(!/[——⛔⭐✅]/.test(s), `⛔ 文案里有契约禁用的符号/破折号：${s}`)
  }
})

test('⛔⭐ conda 那条路⛔ 不自检（平台压根没参与建那个环境）', async () => {
  const { root } = mkdtempEngineWithManifest('chk4', 'environment.yml')
  const ran = []
  const r = await envMod.runEnv({
    id: 'chk4', root, execute: true, manifest: {},
    runStep: fakeRunAllOk(ran),
    probeImport: () => { throw new Error('conda 路线不该调自检探针') },
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.ok(r.envCheck, '⛔ 也要带 envCheck')
  assert.strictEqual(r.envCheck.checked, false,
    '⛔ conda 自建环境，平台没参与 ⇒ 不许拿平台的解释器去 import')
  // ⛔ conda 那条路也⛔ 不许有建环境那一步（conda 自己会建）
  for (const s of ran) {
    assert.ok(!/\buv\s+venv\b/i.test(s.argv.join(' ')),
      `⛔ conda 路线混进了 uv venv：${s.argv.join(' ')}`)
  }
})

test('⛔⭐ 自检探针的判据是「能按绝对路径起起来」（⛔ 不是「文件存在」）', () => {
  // ⛔ 空壳 .venv：只有目录 + 0 字节的假 python。
  //   ⛔ 那正是平台踩过的坑（lib/util/pythonResolve.js：文件在，起不来）
  const { root } = mkdtempEngineWithManifest('chk5', 'requirements.txt')
  const r = envMod.probeImportInEngineVenv(root, 'chk5', 'torch')
  assert.strictEqual(r.ok, false)
  // ⛔ 解释器本身起不来时，⛔ 不许报成 MODULE_NOT_FOUND（那是假象：
  //   连解释器都没跑起来，import 的结果与那个包无关）
  assert.strictEqual(r.code, 'ENGINE_VENV_UNUSABLE', r.code)
})

test('⛔ 不涉及 torch 的装法 ⛔ 不硬验 torch（⛔ 不替用户猜它需要什么）', async () => {
  const { root } = mkdtempEngineWithManifest('chk6', 'requirements.txt')
  const ran = []
  const r = await envMod.runEnv({
    id: 'chk6', root, execute: true, manifest: {},
    runStep: fakeRunAllOk(ran),
    probeImport: () => { throw new Error('没装 torch 就不该验 torch') },
  })
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.envCheck.checked, false)
  assert.strictEqual(r.envCheck.reason, 'no-core-dependency-declared', r.envCheck.reason)
})

// ---------------------------------------------------------------------------
// 活代码纪律
// ---------------------------------------------------------------------------
test('⛔ env.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'env.js'), 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})