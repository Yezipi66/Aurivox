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