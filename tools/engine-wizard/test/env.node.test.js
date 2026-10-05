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
test('⛔⭐ 装法的依据**只能是清单文件名**（不许猜包名/版本/索引源）', () => {
  // ⚠ 2026-10-05 Owner 改判后的边界：
  //   兜底是「按上游的依赖清单推」，⛔ 不是「退回 uv sync」。
  //   ⛔ 推的依据**只有文件名** —— 出现包名、版本号、索引源就是越界。
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'env.js'), 'utf8')
  const fn = src.slice(src.indexOf('function suggestEnvCommand'),
    src.indexOf('function detectDependencyManifest'))
  assert.ok(fn, '找不到 suggestEnvCommand')
  // ⛔ 不许有 --index-url / --extra-index-url（平台不该决定去哪下）
  assert.ok(!/extra-index|index-url|--trusted-host|-i\s+http/i.test(fn),
    `⛔ 装法里不该出现索引源/信任主机（那是装用户自己该定的）：\n${fn}`)
  // ⛔ 不许有具体的包名（torch==2.x 之类）
  assert.ok(!/\btorch\b|\bnumpy\b|\bdiffusers\b|\btorchaudio\b/i.test(fn),
    '⛔ 装法里不该出现具体包名 —— 那是上游清单的内容，不是平台该定的')
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
