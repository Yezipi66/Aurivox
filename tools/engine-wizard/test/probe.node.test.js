'use strict'
// 探测器 —— ⭐ 判据是「**提取到就给，提取不到就说没有**」，不是「总能给出个值」
//
//  ⚠ 这些测试里带了真实上游的字段名（speech-kit 那份 pyproject 的结构），
//   ⛔ 但**不许在 core/probe.js 的活代码里**出现任何具体引擎名。

const { test } = require('node:test')
const { extractDownloadCommands, parseDownloadCmd } = require('../core/wizardbridge')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { probePyproject, probeProject, detectDependencyFile } =
  require('../core/probe.js')

// ---------------------------------------------------------------------------
// 一份结构完整的 pyproject（形状照真实的规范项目写）
// ---------------------------------------------------------------------------
const GOOD = `
[project]
name = "speechkit"
description = "x"
license = "Apache-2.0"
requires-python = ">=3.10"
dependencies = [
    "torch>=2.5.0",
    "torchaudio>=2.5.0",
]

[project.scripts]
speechkit = "speechkit.cli:main"

[project.optional-dependencies]
dev = ["pytest"]

[tool.setuptools.packages.find]
where = ["src"]
include = ["speechkit*"]
`

// ---------------------------------------------------------------------------
test('读出 [project.name] / [project.scripts] / src 布局', () => {
  const p = probePyproject(GOOD)
  assert.strictEqual(p.found, true)
  assert.strictEqual(p.name, 'speechkit')
  assert.deepStrictEqual(p.scripts,
    { speechkit: { module: 'speechkit.cli', attr: 'main' } })
  assert.strictEqual(p.srcRoot, 'src')
  assert.strictEqual(p.requiresPython, '>=3.10')
  assert.strictEqual(p.license, 'Apache-2.0')
})

// ---------------------------------------------------------------------------
test('⛔ ⭐ 提取不到就必须说没有 —— 不能返回半截默认值', () => {
  const p = probePyproject('')
  assert.strictEqual(p.found, false)
  assert.deepStrictEqual(p.scripts, {})
  assert.strictEqual(p.name, undefined)

  const p2 = probePyproject('[build-system]\nrequires = ["setuptools"]\n')
  assert.strictEqual(p2.found, true, 'section 是有的')
  assert.strictEqual(p2.name, undefined, '⛔ 没有 [project.name] 就不该有包名')
  assert.deepStrictEqual(p2.scripts, {}, '⛔ 没有 scripts 就是空')
})

test('⛔ null / 非字符串不能让探测器炸掉', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    const p = probePyproject(bad)
    assert.ok(p && typeof p === 'object')
    assert.strictEqual(p.name, undefined)
  }
})

// ---------------------------------------------------------------------------
// ⭐ 核心：多命令时**不许替用户挑**
// ---------------------------------------------------------------------------
test('⛔ 上游给多个命令时，如实说要人来挑，不自动选一个', () => {
  const multi = `
[project]
name = "thing"
[project.scripts]
thing = "thing.cli:main"
thing-web = "thing.web:main"
`
  const r = probeProject({ pyproject: multi, filenames: ['pyproject.toml'] })
  assert.ok(!('runtime.entry' in r.values),
    `自动挑了一个：${r.values['runtime.entry']}`)
  const u = r.unfilled.find((x) => x.key === 'runtime.entry')
  assert.ok(u, '必须报告「推不出来」')
  assert.ok(u.why.includes('thing-web'), '要把候选都列出来')
})

test('单命令 ⇒ 给它，并说清从哪读到的', () => {
  const r = probeProject({ pyproject: GOOD, filenames: ['pyproject.toml'] })
  assert.strictEqual(r.values['runtime.entry'], 'speechkit')
  assert.strictEqual(r.values['call.module'], 'speechkit')
  assert.ok(r.sources['runtime.entry'].includes('[project.scripts]'))
  assert.ok(r.sources['call.module'].includes('[project.name]'))
})

// ---------------------------------------------------------------------------
test('⛔ 没有 scripts 时要说「上游只给 python API」，不能编一个入口', () => {
  const noScripts = `
[project]
name = "thing"
`
  const r = probeProject({ pyproject: noScripts, filenames: ['pyproject.toml'] })
  assert.ok(!('runtime.entry' in r.values))
  assert.ok(r.unfilled.some((x) => x.key === 'runtime.entry'))
  assert.strictEqual(r.values['call.module'], 'thing')
})

test('⛔ 没有 [project.name] 时，退到 scripts 的模块名 —— 仍是读出来的', () => {
  const noName = `
[project.scripts]
thing = "thingpkg.cli:main"
`
  const r = probeProject({ pyproject: noName, filenames: ['pyproject.toml'] })
  assert.strictEqual(r.values['call.module'], 'thingpkg')
  assert.ok(r.sources['call.module'].includes('scripts'),
    '要说清是从 scripts 退出来的，不是从 name')
})

test('⛔ 什么都没读到 ⇒ 全部进 unfilled，且 values 几乎是空的', () => {
  const r = probeProject({ pyproject: '', filenames: [] })
  assert.ok(!('call.module' in r.values))
  assert.ok(!('runtime.entry' in r.values))
  assert.ok(r.unfilled.length >= 2)
  for (const u of r.unfilled) {
    assert.ok(u.why && u.example, `${u.key} 缺 why 或 example`)
  }
})

// ---------------------------------------------------------------------------
// 依赖清单探测 —— 决定装法
// ---------------------------------------------------------------------------
test('依赖清单：pyproject 优先，锁文件次之', () => {
  const r = detectDependencyFile(['README.md', 'requirements.txt', 'pyproject.toml'])
  assert.strictEqual(r.found, true)
  assert.strictEqual(r.primary.kind, 'pyproject')
  assert.strictEqual(r.all.length, 2)
})

test('只有 requirements.txt（老项目）也能认', () => {
  const r = detectDependencyFile(['requirements.txt'])
  assert.strictEqual(r.primary.kind, 'requirements')
})

test('⛔ 一个都没有 ⇒ 如实说「没有」，不猜', () => {
  const r = detectDependencyFile(['README.md', 'assets/logo.png'])
  assert.strictEqual(r.found, false)
  // ⭐ 只钉实质：确实说了「没有清单」
  assert.ok(/没找到|没有/.test(r.note), r.note)
  // ⛔⛔ 不许出现「平台不替你猜」这类内部术语（Owner 反复强调的口吻问题）
  assert.ok(!/平台不替你猜|平台不会替你|——/.test(r.note),
    `⛔ 不许出现内部术语或破折号：${r.note}`)
})

test('conda 环境文件能被认出来', () => {
  assert.strictEqual(detectDependencyFile(['environment.yml']).primary.kind, 'conda')
})

// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
test('⛔ probe.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm', 'chat' + 'tts']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'probe.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

// ---------------------------------------------------------------------------
// ⭐⭐ 第 3 步：上游自己的下载方式（2026-10-05 Owner）
//
// 「从现在开始，模型不再需要统一管理」
//   ⇒ ⛔ 平台不替上游决定模型下到哪、下哪几个文件、用 hf 还是 modelscope。
//
// 「四条命令让用户自己选……用户可以自选目录，也就是 --local-dir=checkpoints
//   这里改一个 --local-dir=path/set/by/user 的事」
//   ⇒ ⭐ 提取出来之后必须**拆成三段**，目标目录是用户可改的。
//   ⛔⛔ 原样丢整条命令 = 把目标目录写死成上游随手取的名 ⇒ 直接判失败。
// ---------------------------------------------------------------------------
const README_MD = [
  '### 3. Download Models',
  '',
  '```',
  '# IndexTTS-2.5',
  'hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints',
  'modelscope download --model IndexTeam/IndexTTS-2.5 --local_dir checkpoints',
  '```',
  '',
  'not a download: pip install -r requirements.txt',
].join('\n')

test('⭐⭐ README 里的下载命令被提取，且**拆成三段**（可改目录）', () => {
  const cmds = extractDownloadCommands(README_MD)
  assert.strictEqual(cmds.length, 2, `应提取到 2 条：${JSON.stringify(cmds)}`)
  // ⭐ 工具 / 模型 / 目录 三段都有
  const hf = cmds.find((c) => c.tool === 'hf')
  assert.ok(hf, '要认得 hf')
  assert.strictEqual(hf.repo, 'IndexTeam/IndexTTS-2.5')
  assert.strictEqual(hf.dir, 'checkpoints')
  const ms = cmds.find((c) => c.tool === 'modelscope')
  assert.ok(ms, '要认得 modelscope')
  assert.strictEqual(ms.repo, 'IndexTeam/IndexTTS-2.5')
  assert.strictEqual(ms.dir, 'checkpoints')
})

test('⛔ 认不出的写法如实返回 null（⛔ 不猜 = 不替上游编下载方式）', () => {
  assert.strictEqual(parseDownloadCmd('pip install -r req.txt'), null)
  assert.strictEqual(parseDownloadCmd('hf upload something'), null)
  assert.strictEqual(parseDownloadCmd('modelscope download'), null)
  // hf 缺仓库名 ⇒ 认不出
  assert.strictEqual(parseDownloadCmd('hf download --local-dir=x'), null)
})

test('⛔⛔ 提取结果**必须带 dir 字段**（否则界面没法让用户改目录）', () => {
  for (const c of extractDownloadCommands(README_MD)) {
    assert.ok('dir' in c,
      `⛔ 这条没有 dir 字段 ⇒ 界面没法让用户改目标目录：${JSON.stringify(c)}`)
    assert.ok('repo' in c && 'tool' in c)
  }
})

test('⛔ 不是下载命令的（pip install）不许被当模型下载', () => {
  assert.strictEqual(extractDownloadCommands('pip install -r requirements.txt').length, 0)
  assert.strictEqual(extractDownloadCommands('uv sync --all-extras').length, 0)
})
