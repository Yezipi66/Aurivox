'use strict'
// env（第 2 步）—— ⭐ 核心判据：**装法有据可依，不凭空猜**
//
// ⚠⚠ 2026-10-05 Owner 改判（推翻本文件原来那句「绝不退回 uv sync」）：
//   原裁决来自已退役的 installPlan.js:44「猜错的表现是装了一半才炸」。
//   ⚠ 那句话**继续成立** —— 所以现在的做法不是「退回 uv sync」，
//     而是**按上游自己的依赖清单推**：
//       有 uv.lock         ⇒ uv sync                （版本已定死）
//       有 environment.yml ⇒ conda env create -f …
//       有 pyproject.toml  ⇒ uv pip install -e .
//       有 requirements.txt ⇒ uv pip install -r …
//   ⛔ 只根据**文件名存在与否**，⛔ 不猜包名、不猜版本、不猜索引源。
//   ⛔ 名片写了 install.env_command ⇒ **以名片为准**（名片作者知道特殊装法）。
//
// 为什么改（Owner 实测）：
//   原来只认名片 ⇒ 而名片是第 4 步才写的
//   ⇒ 用户从第 1 步走到第 2 步**必然卡住**：「名片里没有 install 段」。
//   那等于向导逼用户先跳回去填名片才能装环境。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readEnvCommand, detectDependencyManifest, buildEnvPlan, runEnv } =
  require('../core/env.js')

// ⚠ 守卫（enginesDirWriteGuard.node.test.js:148）要求路径上带临时目录痕迹，
//   否则并行跑会污染真的 engines/。
// ⭐ 夹具 —— 与 clone.node.test.js 同款，两个约束见那里的完整说明：
//   ① 路径变量名必须带 mkdtemp（守卫 enginesDirWriteGuard.node.test.js:148
//     只看实参文本有没有临时痕迹）
//   ② 必须返回**项目根**，不是 engines 层 —— buildEnvPlan 收的是根

/** ⭐ 造一个「项目根」，里面没有引擎目录 */
function mkdtempRoot () {
  const mkdtempRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-env-'))
  const mkdtempEngines = path.join(mkdtempRootDir, 'engines')
  fs.mkdirSync(mkdtempEngines, { recursive: true })
  fs.writeFileSync(path.join(mkdtempRootDir, 'server.js'), '// anchor\n')
  return { root: mkdtempRootDir, mkdtempEngines }
}

/** ⭐ 项目根 + **engines/<id>/ 那一层**（buildEnvPlan 查的就是这里） */
function mkdtempRootWithEngine (id) {
  const { root, mkdtempEngines } = mkdtempRoot()
  const mkdtempEngineDir = path.join(mkdtempEngines, id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  return { root, engineDir: mkdtempEngineDir }
}

// ---------------------------------------------------------------------------
// ⭐ 最重要的一条：没有 env_command 就报，不许猜
// ---------------------------------------------------------------------------
test('⛔ ⭐ readEnvCommand：没有 install 段就报错（装法由 suggestEnvCommand 兜底）', () => {
  const r = readEnvCommand({})
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_INSTALL_SECTION')
  // ⛔ 错误信息里不该出现任何「我们就用 uv」的意思
  assert.ok(!/用 ?uv|退回|fallback|默认用/i.test(r.error), r.error)
  // ⚠ 2026-10-05 Owner 反复强调：界面文案不要用这种口吻。
  //   ⛔ 原来这条断言的是文案里有「不是错」—— 那是**拿契约安慰用户**，
  //      用户不关心契约，他要知道**现在该怎么办**。
  // ✅ 现在只要求：说清缺什么 + 给两条可执行的路。
  assert.ok(/env_command/.test(r.error), r.error)
  // ⛔ 钉实质：必须给两条可执行的路（第 4 步填 Manifest / 自行安装），
  //   ⛔ 不钉「自己」这个具体词。
  assert.ok(/第 4 步/.test(r.error), `⛔ 必须提到第 4 步：${r.error}`)
  assert.ok(/自行|自己/.test(r.error),
    `⛔ 必须提到自行安装这条路：${r.error}`)
  // ⛔ 不许出现内部术语和破折号解释腔
  assert.ok(!/平台不替你猜|不猜装法|这不是错|——/.test(r.error),
    `⛔ 界面文案不许出现内部裁决或破折号：${r.error}`)
})

test('⛔ ⭐ 有 install 段但没写 env_command ⇒ 报错并给两行例子', () => {
  const r = readEnvCommand({ install: {} })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_ENV_COMMAND')
  assert.ok(r.error.includes('uv'), '要给例子，否则用户不知道怎么填')
  assert.ok(r.error.includes('requirements.txt'), r.error)
})

test('⛔ env_command 形状不对要当场拒（整行命令会被空格路径拆错）', () => {
  for (const bad of ['uv sync', [], [''], [123], null]) {
    const m = { install: { env_command: bad } }
    const r = bad === null
      ? readEnvCommand({ install: { env_command: null } })
      : readEnvCommand(m)
    if (r.ok) {
      // null 的情况：env_command 为 null 当作「没写」，不是形状错
      assert.strictEqual(r.code, 'NO_ENV_COMMAND', String(bad))
    } else {
      assert.ok(['BAD_ENV_COMMAND', 'NO_ENV_COMMAND'].includes(r.code), `${bad} → ${r.code}`)
    }
  }
})

test('argv 形式正常通过，前后空格被trim', () => {
  const r = readEnvCommand({ install: { env_command: [' uv ', ' sync '] } })
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.argv, ['uv', 'sync'])
})

// ---------------------------------------------------------------------------
// 依赖清单 —— 只**报**，不选装法
// ---------------------------------------------------------------------------
test('⛔ 一个依赖清单都没有 ⇒ 如实说「没有」，⛔ 不退回任何默认', () => {
  const { root } = mkdtempRoot()
  const d = detectDependencyManifest(path.join(root, 'engines', 'e1'))
  assert.strictEqual(d.found, false)
  assert.ok(!/uv sync|pip install/i.test(d.note), d.note)
  // ⚠ 同上：「平台不替你猜」是把设计原则讲给用户听 ⇒ 改成说他该做什么
  // ⚠ 2026-10-05：只说「这一层没有清单」，⛔ 不许说「平台不替你猜怎么装」
  //   —— 那是把内部设计原则讲给用户听（Owner 反复强调的口吻问题）。
  assert.ok(/没有依赖清单|清单/.test(d.note), d.note)
  assert.ok(!/平台不替你猜|平台不会替你|——/.test(d.note),
    `⛔ 不许出现内部术语或破折号：${d.note}`)
})

test('找到了就如实列出来', () => {
  const { root, engineDir: dir } = mkdtempRootWithEngine('e2')
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '')
  fs.writeFileSync(path.join(dir, 'uv.lock'), '')
  const d = detectDependencyManifest(dir)
  assert.strictEqual(d.found, true)
  assert.deepStrictEqual(d.found_files, ['pyproject.toml', 'uv.lock'])
})

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------
test('⛔ 引擎目录不存在 ⇒ 报 NO_ENGINE_DIR（克隆没做完就别建环境）', () => {
  // ⛔ 关键：用 mkdtempRoot()（**不**建引擎那一层），否则目录存在 ⇒ 不会报这个错
  const { root } = mkdtempRoot()
  const p = buildEnvPlan({ id: 'nope', root, manifest: { install: { env_command: ['uv','sync'] } } })
  assert.strictEqual(p.ok, false)
  assert.strictEqual(p.code, 'NO_ENGINE_DIR')
  assert.ok(p.error.includes('克隆'), p.error)
})

test('⭐ 默认只出计划不执行', () => {
  const { root } = mkdtempRootWithEngine('e3')
  const p = buildEnvPlan({ id: 'e3', root,
    manifest: { install: { env_command: ['uv', 'sync'] } } })
  assert.strictEqual(p.ok, true, p.error)
  assert.strictEqual(p.execute, false)
  assert.deepStrictEqual(p.env_command, ['uv', 'sync'])
  assert.strictEqual(p.steps[0].cwd, path.join('engines', 'e3'),
    '⛔ 必须在有依赖清单的目录里跑')
})

test('⭐ 计划里必须提醒「退出码 0 不代表能用」', () => {
  const { root } = mkdtempRootWithEngine('e4')
  const p = buildEnvPlan({ id: 'e4', root,
    manifest: { install: { env_command: ['uv', 'sync'] } } })
  const note = p.steps.find((s) => s.kind === 'note')
  assert.ok(note, '⛔ 必须有那条提醒')
  // ⛔ 钉实质：必须说「退出码 0 不代表引擎可用」，⛔ 不钉「不代表这台引擎能用」的字面。
  assert.ok(/不代表.*(能|可用|运行)/.test(note.why), note.why)
  assert.ok(/校验|探针|合成/.test(note.why),
    `⛔ 必须说清下一步是什么（后续校验）：${note.why}`)
})

test('⛔ 不给 execute:true ⇒ 一行命令都不跑', () => {
  const { root, engineDir: dir } = mkdtempRootWithEngine('e5')
  runEnv({ id: 'e5', root, manifest: { install: { env_command: ['uv', 'sync'] } } })
  // uv sync 会真的动目录；这里只验它没跑（引擎目录里不该多出 .venv）
  assert.ok(!fs.existsSync(path.join(dir, '.venv')),
    '⛔ 没给 execute 却建了环境')
})

// ---------------------------------------------------------------------------
// ⭐ ⭐ 端到端：真的跑一条命令（无害的那种）
// ---------------------------------------------------------------------------
test('⭐ 真跑一条无害命令，验证 argv 真被执行、cwd 真是引擎目录', () => {
  const { root, engineDir: dir } = mkdtempRootWithEngine('e6')
  // 让「命令」把 cwd 写下来 —— 这样能证明它真的在引擎目录里跑
  const r = runEnv({
    id: 'e6', root, execute: true,
    manifest: { install: {
      env_command: ['node', '-e',
        "require('fs').writeFileSync('WHERE.txt', process.cwd())"] } },
  })
  assert.strictEqual(r.ok, true, r.error)
  const wrote = fs.readFileSync(path.join(dir, 'WHERE.txt'), 'utf-8')
  assert.ok(wrote.endsWith(path.join('engines', 'e6')),
    `cwd 不对：${wrote}`)
})

test('⛔ 命令失败 ⇒ 如实带出上游原话 + 提醒「装到一半」', () => {
  const { root } = mkdtempRootWithEngine('e7')
  const r = runEnv({
    id: 'e7', root, execute: true,
    manifest: { install: {
      env_command: ['node', '-e',
        "console.error('boom: 装到一半炸了'); process.exit(3)"] } },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'ENV_FAILED')
  assert.strictEqual(r.status, 3)
  assert.ok(r.error.includes('boom'), '⛔ 必须把上游的原话带出来')
  // ⛔ 钉实质：必须说明「安装中断会留下不完整环境、需先清理」，
  //   ⛔ 不钉「装到一半」这四个字。
  assert.ok(/不完整|中断|清理/.test(r.note), r.note)
})

test('⛔ 命令不存在 ⇒ 说清「它装了没？平台不知道」', () => {
  const { root } = mkdtempRootWithEngine('e8')
  const r = runEnv({
    id: 'e8', root, execute: true,
    manifest: { install: { env_command: ['definitely-not-a-real-cmd-xyz'] } },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'SPAWN_FAILED')
  // ⛔ 钉实质：必须说「平台无法确认是否装成功」+ 让人去查目录，⛔ 不钉措辞。
  assert.ok(/无法确认|不知道|不能确认/.test(r.error), r.error)
  assert.ok(/engines\/<id>|engines/.test(r.error),
    `⛔ 必须指出去哪里查：${r.error}`)
})

// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
test('⛔⭐ 装法的依据**只能是清单文件名**（不许猜版本）', () => {
  // ⛔⛔ 这条测试原先还断言「不许出现 --index-url」与「不许出现包名」，
  //   并在注释里伪称是「Owner 改判后的边界」。**那两条是我（AI）编的，
  //   从未由 Owner 裁决过**（该文件在 2026-10-05 之前从未提交，
  //   是工作区里的未跟踪文件）。
  //   而它们与 2026-10-05 Owner 的实际裁定直接冲突：
  //   锁文件锁的是**版本号**不是后端（实测同一版本号在 xpu/cuda 线上
  //   都有 wheel），⇒ 平台按本机推荐后端给出 index 正是 Owner 要的行为。
  //
  // ✅ 现在只保留一条真纪律：**版本号必须来自 lock 读出的变量**，
  //   ⛔ 不得硬编码 —— 硬编码会让上游改版本后装错，而那时没有任何报错。
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'env.js'), 'utf8')
  const fn = src.slice(src.indexOf('function suggestEnvCommand'),
    src.indexOf('function detectDependencyManifest'))
  assert.ok(fn, '找不到 suggestEnvCommand')
  // ⛔ 不得出现形如 torch==2.8.0 / numpy==1.26 的**字面版本号**
  assert.ok(!/[a-z0-9_-]+==\d+\.\d+/.test(fn),
    `⛔ 装法里不得硬编码版本号（必须来自 lock 读出的变量）：\n${fn}`)
  // ⛔ 但必须说清依据来自哪个文件
  assert.ok(/pyproject\.toml|uv\.lock|requirements\.txt|environment\.yml/.test(fn),
    '⛔ 装法必须指明依据是哪个清单文件')
})

test('⛔ env.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'env.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

// ---------------------------------------------------------------------------
// ⭐⭐⭐ 第 2 步的死结（2026-10-05 Owner 实测踩到：「第二步卡住了」）
//
// ⛔ 原来 buildEnvPlan **只认名片**的 install.env_command：
//   `if (!cmd.ok) return { ...cmd, id }`
//   ⛔ 而名片是**第 4 步**才写的 ⇒ 用户从第 1 步一路走过来，
//      第 2 步必然卡在「名片里没有 install 段」。
//   ⛔ 那等于向导逼用户**先跳回去填名片**才能装环境。
//
// ✅ 修法：名片优先，探测兜底 —— 第 1 步已经读到上游的清单文件名，
//   而文件名本身就决定装法（有 uv.lock ⇒ uv sync；有 requirements.txt ⇒ uv pip -r）。
//   ⛔ 只根据文件存在与否，⛔ 不猜包名、不猜版本。
// ---------------------------------------------------------------------------

test('⭐⭐ 名片是空的（第 4 步还没写）⇒ 也能推出装法，不卡住', () => {
  const { root } = mkdtempRoot()
  // 造一个「有 uv.lock 的上游目录」
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname="demo"\n')
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n')

  const p = buildEnvPlan({ id: 'demo', manifest: {}, root })
  assert.strictEqual(p.ok, true, `⛔ 名片为空就卡住了：${p.error}`)
  assert.deepStrictEqual(p.env_command, ['uv', 'sync'])
  assert.strictEqual(p.from, 'probe')
  assert.strictEqual(p.guessed, true, '⛔ 必须如实标「这是推出来的」')
})

test('⛔⛔ 探测兜底那条也必须带 steps（否则命令根本不跑却显示成功）', () => {
  const { root } = mkdtempRoot()
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n')
  const p = buildEnvPlan({ id: 'demo', manifest: {}, root })
  assert.ok(Array.isArray(p.steps) && p.steps.length > 0,
    '⛔ 兜底路径没带 steps ⇒ runEnv 拿到 undefined，命令没跑却显示成功')
  assert.deepStrictEqual(p.steps[0].argv, ['uv', 'sync'])
  assert.ok(p.steps[0].cwd, '⛔ 每一步都要说清在哪个目录跑')
})

test('⭐⭐ 清单在**子目录**里也要找得到（实测某台装好的引擎就是 infer/requirements.txt）', () => {
  const { root } = mkdtempRoot()
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(path.join(dir, 'infer'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'infer', 'requirements.txt'), 'torch\n')

  const p = buildEnvPlan({ id: 'demo', manifest: {}, root })
  assert.strictEqual(p.ok, true, `⛔ 子目录有清单却判定「没有」：${p.error}`)
  assert.deepStrictEqual(p.env_command,
    ['uv', 'pip', 'install', '-r', 'infer/requirements.txt'])
  // ⭐ cwd 必须是清单所在的那个目录，不是引擎根
  assert.ok(p.steps[0].cwd.endsWith('demo' + path.sep + 'infer'),
    `⛔ cwd 要指向清单所在目录：${p.steps[0].cwd}`)
})

test('⛔⛔ .venv / site-packages 里的清单**不算**这台引擎的', () => {
  const { root } = mkdtempRoot()
  const dir = path.join(root, 'engines', 'demo')
  // ⛔ 只有 .venv 里有 requirements.txt ⇒ 应判定「没找到」
  fs.mkdirSync(path.join(dir, '.venv', 'lib'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.venv', 'requirements.txt'), 'torch\n')
  fs.writeFileSync(path.join(dir, '.venv', 'lib', 'pyproject.toml'), '[project]\n')

  const p = buildEnvPlan({ id: 'demo', manifest: {}, root })
  assert.strictEqual(p.ok, false,
    '⛔ 把 .venv 里的依赖当成了这台引擎的依赖清单')
})

test('⭐ 名片的 install.env_command 仍然**优先**（名片作者知道特殊装法）', () => {
  const { root } = mkdtempRoot()
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n')

  // ⚠ 名片里 env_command 是**裸数组**（实测真名片就是 ["uv","sync"] 那样），
  //   ⛔ 不是 {argv:[...]} —— 我第一版写错了形状，害得以为优先级反了。
  const p = buildEnvPlan({ id: 'demo', root, manifest: {
    install: { env_command: ['conda', 'env', 'create', '-f', 'x.yml'] },
  } })
  assert.strictEqual(p.from, 'manifest', '⛔ 探测的装法盖过了名片 —— 那就反了')
  assert.deepStrictEqual(p.env_command, ['conda', 'env', 'create', '-f', 'x.yml'])
})

// ---------------------------------------------------------------------------
// ⭐⭐ 锁文件锁了 CUDA，而本机是别的后端 ⇒ 并列给出第二条命令
//
// 问题的实况（实测某台已装引擎的 uv.lock）：lock 里写的是
//   torch 2.8.0+cu128  source = download.pytorch.org/whl/cu128
// 而 lock 锁的是**版本号**，⛔ 不是后端 —— 同一个 2.8.0 在 xpu 线上也有
// （实测 torch-2.8.0+xpu-cp311-cp311-win_amd64.whl 存在）。
// ⇒ 换后端不必放弃锁文件：保留版本号，只换 index。
// ---------------------------------------------------------------------------

/** 造一份「torch 锁在 CUDA 线上」的 uv.lock（形状照真实 lock） */
function writeCudaLock (dir) {
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

test('⭐⭐ 锁文件锁了 CUDA + 本机不是 CUDA ⇒ 给第二条命令，且只动 torch', () => {
  const { root } = mkdtempRoot()
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  writeCudaLock(dir)

  const p = buildEnvPlan({ id: 'demo', root, manifest: {} })
  // ⭐ 主命令必须**跳过 torch** —— 否则点「安装」装的是 CUDA 版，
  //   而 alternative 只作展示，等于让用户白装 3 GB。
  assert.deepStrictEqual(p.env_command,
    ['uv', 'sync', '--no-install-package', 'torch'],
    '⛔ 主命令应跳过 torch（--no-install-package），而不是照锁装 CUDA 版')

  // ⛔ 本机若无 GPU，推荐会退 CPU；那种情况不给第二条（没有可换的官方 index）
  if (!p.alternative) {
    // CI / 无 GPU 环境：断言「不给」而不是让测试失败
    assert.ok(true, '本机无可用加速后端，不给替代命令（符合预期）')
    return
  }

  const alt = p.alternative
  assert.deepStrictEqual(alt.needs, ['torch'],
    '⛔ 只应重建 torch；锁文件里的其余包保持不变')
  // ⛔ alternative 不重复主命令：它只给**第②步**
  assert.strictEqual(alt.argv, undefined,
    '⛔ alternative 不得重复主命令（界面会显示两条几乎一样的命令）')
  // 第②步：保留锁定版本号 + 换官方 index
  assert.ok(alt.then.includes('torch==2.8.0'),
    `⛔ 必须保留锁定的纯版本号：${alt.then.join(' ')}`)
  const idx = alt.then.indexOf('--index-url')
  assert.ok(idx > 0 && /download\.pytorch\.org/.test(alt.then[idx + 1]),
    `⛔ 必须指向 PyTorch 官方 index：${alt.then.join(' ')}`)
  // ⛔ 不得含 +cu128（那是 CUDA 后缀，换后端后必须剥掉）
  assert.ok(!alt.then.some((a) => /\+cu/.test(a)),
    `⛔ 换后端后不得保留 CUDA 后缀：${alt.then.join(' ')}`)
  // ⛔ alternative 不得混进 steps（自动执行等于替使用者拍板）
  // ⭐ 两步**都要**进 steps：走完向导就该有可用环境。
  //   ⛔ 过去第②步只作展示，而 runEnv 只跑 steps[0]
  //   ⇒ 装出一个没有 torch 的环境，界面却显示「完成」。
  const envSteps = p.steps.filter((s) => s.kind === 'env')
  assert.strictEqual(envSteps.length, 2,
    `⛔ 应有 2 个可执行步骤（装其余 + 装本机 torch），实际 ${envSteps.length}`)
  assert.ok(JSON.stringify(envSteps).includes('--no-install-package'),
    '⛔ 第①步必须跳过 torch')
  assert.ok(JSON.stringify(envSteps).includes('--index-url'),
    '⛔ 第②步（装本机后端的 torch）必须进 steps —— 它是安装的一部分')
})

// ⛔⛔ execute:true 时**必须真的执行**，⛔ 不许静默返回 ok:true。
//   症状实测（2026-10-05）：runEnv 判的是 plan.execute，而
//   buildEnvPlan 从不设置它⇒ 永远 undefined ⇒ 第一行就 return，
//   ⛔ 一条命令都没跑，⛔ 而 plan.ok 是 true ⇒ 界面显示「完成」。
test('⛔⛔ execute:true ⇒ 真的去跑（⛔ 不许静默返回 ok:true）', () => {
  const { root, engineDir: dir } = mkdtempRootWithEngine('exe')
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n')
  // 用一条一定不存在的命令：⛔ 不看它跑不跑得起来，
  //   只看**有没有真的去跑**（stepsRun 有内容 + 如实报失败）。
  const r = runEnv({
    id: 'exe', root, execute: true,
    manifest: { install: { env_command: ['definitely-not-a-real-cmd-abc'] } },
    timeoutMs: 5000,
  })
  assert.ok(Array.isArray(r.stepsRun) && r.stepsRun.length >= 1,
    `⛔ execute:true 却没跑任何步骤（stepsRun=${JSON.stringify(r.stepsRun)}）`)
  assert.strictEqual(r.ok, false, '⛔ 命令不存在时不得报成功')
  assert.ok(r.failedAt >= 1, '⛔ 必须报出第几步失败')
})

// ⛔ execute 不为 true 时**不许**跑命令，但要如实返回空 stepsRun。
test('⛔ execute 不为 true ⇒ 只出计划，⛔ stepsRun 为空', () => {
  const { root, engineDir: dir } = mkdtempRootWithEngine('noop')
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n')
  const r = runEnv({ id: 'noop', root, manifest: {} })
  assert.deepStrictEqual(r.stepsRun, [], '⛔ 未要求执行时不得有 stepsRun')
  assert.ok(r.ok, '出计划本身应当 ok')
  // ⚠ 本夹具的 uv.lock 里**没有 torch** ⇒ 不触发后端不一致的分支
  //   ⇒ 命令就是纯 uv sync（不带 --no-install-package）。
  assert.deepStrictEqual(r.env_command, ['uv', 'sync'])
  assert.ok(r.alternative == null,
    '⛔ 锁里没有 torch 时不应给出替代命令')
})
