'use strict'

// ---------------------------------------------------------------------------
//  lib/engines/envCheck.js —— 第一道校验「这台引擎装没装」
// ---------------------------------------------------------------------------
// 这一组守卫的取证方式：**真的把东西摆到盘上**，然后问 envCheck 怎么判。
// 不 mock fs，不 mock spawn。理由和 configRepair.node.test.js 那组一样 ——
// 这个模块的全部价值就在于"它对盘上的实际状态怎么说"，把盘 mock 掉之后
// 剩下的只是在测试我自己写的假 fs。
//
// 深层那几条要真起一个 Python 解释器。⚠ 找不到 python 时整组 skip 并说明
// 原因 —— 沉默地跳过等于没有守卫（沙箱和真机的 skip 数落差本身就是信号：
// 2a 那次真机只 skip 1 条、沙箱 skip 32 条，正好反证了探针在真机真跑了）。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { checkEngineEnvShallow, checkEngineEnvDeep, resolveRuntimePaths, PROBE } = require('./envCheck')

// --- 夹具 -------------------------------------------------------------------

let seq = 0
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aurivox-envcheck-${++seq}-`))
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '')
  return file
}

// 一个够用的假 profile：只带 envCheck 真正读的那几个字段。
function fakeProfile(root, runtime, id = 'demo') {
  return { id, dir: path.join(root, 'engines', id), runtime }
}

function findPython() {
  for (const cand of [
    path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe'),
    path.join(__dirname, '..', '..', 'venv', 'bin', 'python'),
  ]) {
    if (fs.existsSync(cand)) return cand
  }
  // ⭐ 一定要还原成绝对路径：裸名字（'python3'）没法参与下面 pythonRef 的
  //   路径运算，会造出一条指不到任何地方的 runtime.python，测试会以
  //   "Cannot read properties of undefined" 这种完全看不出病因的形状挂掉。
  for (const name of ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys; sys.stdout.write(sys.executable)'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0 && (probe.stdout || '').trim()) return probe.stdout.trim()
  }
  return null
}

/**
 * 给临时项目根算一条能指到这台机器真解释器的 runtime.python。
 *
 * ⛔⛔ 这里原先是 `fs.symlinkSync(PYTHON, root/bin/python)`，在 Linux 沙箱上
 *   跑得很顺，到真机（Windows）直接 `EPERM: symlink` 整组挂掉 —— Windows
 *   非管理员且没开开发者模式**不许建符号链接**。教训不是"少用 symlink"，
 *   而是：**凡在测试里动文件系统的特权操作（symlink / 硬链接 / 权限位），
 *   沙箱是 Linux 就结构上验不出 Windows 会拒绝**。
 *
 * ⭐ 换法要保住原来的取证目的：这几条深层测试要覆盖的是「名片上的相对
 *   路径 → 落地到一个真能跑的解释器」这条链，而不是"symlink 能不能建"。
 *   所以改成算一条**从临时项目根出发的路径**交给名片，仍然完整走
 *   resolveRuntimePaths 的 path.resolve(rootDir, rt.python)，一个链接都不建。
 *   ⚠ Windows 上临时目录在 C:、仓库在 D: 时，path.relative 跨盘会直接返回
 *     绝对路径 —— path.resolve 对绝对路径原样返回，这条链照样成立。
 */
function pythonRef(root) {
  return path.relative(root, PYTHON)
}

const PYTHON = findPython()
const noPython = { skip: PYTHON ? false : '这台机器上找不到可用的 python，深层校验的守卫无法取证' }

// ---------------------------------------------------------------------------
//  浅层
// ---------------------------------------------------------------------------

test('浅层：解释器和入口都在，判「装了」', () => {
  const root = tmpRoot()
  touch(path.join(root, 'venv', 'bin', 'python'))
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const r = checkEngineEnvShallow(p, { rootDir: root })
  assert.equal(r.ok, true, r.problems.join('\n'))
  assert.deepEqual(r.problems, [])
})

test('浅层：解释器不在就判「没装」，且报错里要有名片原文和落地路径', () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const r = checkEngineEnvShallow(p, { rootDir: root })
  assert.equal(r.ok, false)
  const text = r.problems.join('\n')
  // ⭐ 两样都要有：名片上写的那一行（人要照着改的东西）和它落到的绝对路径
  //   （人要照着去看的地方）。只给其中一个，排障就得再问一次。
  assert.match(text, /venv\/bin\/python/)
  assert.match(text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('⭐ 浅层：路径少写一个字符就该红 —— 这正是名片里 .venv 写成 venv 的那个错', () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', '.venv', 'bin', 'python'))
  const planted = touch(path.join(root, 'engines', 'demo', 'shim.py'))
  assert.ok(fs.existsSync(planted))

  const good = fakeProfile(root, {
    python: 'engines/demo/.venv/bin/python', entry: 'shim.py', args: [], cwd: null,
    checkpoints: null, ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const bad = fakeProfile(root, {
    python: 'engines/demo/venv/bin/python', entry: 'shim.py', args: [], cwd: null,
    checkpoints: null, ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  assert.equal(checkEngineEnvShallow(good, { rootDir: root }).ok, true)
  assert.equal(checkEngineEnvShallow(bad, { rootDir: root }).ok, false,
    '少一个点没被抓住 —— 这道校验存在的全部理由就是抓这个')
})

test('浅层：解释器在但入口脚本不在，也要判「没装」', () => {
  // ⭐ 这条是突变验证补出来的：原先只有"解释器不在"那条，把 entry 的检查
  //   整块删掉，测试一条都没红 —— 因为每个红都是 python 先红的。
  //   两个条件必须各有一条**只让它单独红**的测试。
  const root = tmpRoot()
  touch(path.join(root, 'venv', 'bin', 'python'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const r = checkEngineEnvShallow(p, { rootDir: root })
  assert.equal(r.ok, false, '入口脚本不在却判成装了')
  assert.match(r.problems.join('\n'), /shim\.py/)
})

test('浅层：entry 相对名片目录，python 相对项目根（两个基准不能混）', () => {
  const root = tmpRoot()
  touch(path.join(root, 'venv', 'bin', 'python'))
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const paths = resolveRuntimePaths(p, root)
  assert.equal(paths.entry, path.join(root, 'engines', 'demo', 'shim.py'))
  assert.equal(paths.python, path.join(root, 'venv', 'bin', 'python'))
  // 如果 entry 也按项目根解析，会落到 root/shim.py —— 那个文件不存在，
  // 但更要命的是它对**别的**引擎会指到错的引擎目录里去。
  assert.notEqual(paths.entry, path.join(root, 'shim.py'))
})

test('浅层：entry 里的 ../.. 要能走出引擎目录（GSV 的入口在平台 lib 下）', () => {
  const root = tmpRoot()
  touch(path.join(root, 'venv', 'bin', 'python'))
  touch(path.join(root, 'lib', 'inference', 'infer_server.py'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: '../../lib/inference/infer_server.py',
    args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const r = checkEngineEnvShallow(p, { rootDir: root })
  assert.equal(r.ok, true, r.problems.join('\n'))
})

// ---------------------------------------------------------------------------
//  权重轴 —— 和「装没装」分开
// ---------------------------------------------------------------------------
// ⛔⛔ 这一组是真机打回来的：indextts2 的 .venv 好端端在盘上，却因为
//   models/tts/indextts2/checkpoints 不存在而被判「没装」。

// ⚠ 故意不写 models/tts/... —— lib/paths.node.test.js 有一条守卫禁止硬编码
//   那个路径段（模型根是可配的）。这里要的只是"一个名片声明的目录"。
const CKPT_REL = 'weights/demo/ckpt'

function ckptProfile(root, ckpt) {
  touch(path.join(root, 'venv', 'bin', 'python'))
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  return fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null,
    checkpoints: ckpt,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
}

test('⭐⭐ 浅层：权重缺**不**影响「装没装」，但要单独报出来', () => {
  const root = tmpRoot()
  const r = checkEngineEnvShallow(ckptProfile(root, CKPT_REL), { rootDir: root })
  // 环境是好的：解释器在、入口在。权重没下是另一件事。
  assert.equal(r.ok, true, '权重没下被算成了"引擎没装" —— 人会去重装一遍已经装好的环境')
  assert.deepEqual(r.problems, [], '权重的话不该混进环境那一栏')
  assert.equal(r.assets.ok, false)
  assert.match(r.assets.problems.join('\n'), /ckpt/)
  // 落地路径和名片原文都要有 —— 和环境那一栏同样的规矩。
  assert.ok(r.assets.problems.join('\n').includes(CKPT_REL), '报错里没有名片原文那一行')
})

test('权重在 ⇒ assets.ok 为 true', () => {
  const root = tmpRoot()
  const p = ckptProfile(root, CKPT_REL)
  fs.mkdirSync(path.resolve(root, CKPT_REL), { recursive: true })
  const r = checkEngineEnvShallow(p, { rootDir: root })
  assert.equal(r.ok, true)
  assert.equal(r.assets.ok, true)
  assert.deepEqual(r.assets.problems, [])
})

test('⭐ 名片没声明 checkpoints ⇒ assets.ok 为 null（无从判断，不是通过）', () => {
  const root = tmpRoot()
  const r = checkEngineEnvShallow(ckptProfile(root, null), { rootDir: root })
  // ⛔ 折成 true 会让"这台引擎压根没说它的权重在哪"显示成"权重齐了"。
  assert.equal(r.assets.ok, null)
  assert.deepEqual(r.assets.problems, [])
})

test('⭐⭐ 权重缺时深层照跑 —— 这正是那个 bug 最贵的后果', noPython, () => {
  // 真机上 indextts2 被浅层的权重检查挡下，于是"它的 Python 环境到底好不好"
  // 这个问题**根本没被问过**。权重和环境是两根轴，一根缺不该让另一根不查。
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  const p = fakeProfile(root, {
    python: pythonRef(root), entry: 'shim.py', args: [], cwd: null,
    checkpoints: CKPT_REL,                        // 故意不建
    ready_endpoint: '/', ready_timeout_ms: 60000, preload: false,
    verify: { sys_path: [], imports: [{ module: 'json', class: null, methods: [], init_params: [] }] },
  })
  const r = checkEngineEnvDeep(p, { rootDir: root })
  assert.equal(r.level, 'deep', '权重缺就不起进程了 —— 深层校验被白白跳过')
  assert.equal(r.ok, true, r.problems.join('\n'))
  assert.equal(r.assets.ok, false, '深层报告把浅层查明的权重状态丢了')
})

test('⭐ 浅层：没有 runtime 段判 null（无从判断），不能判成绿也不能判成红', () => {
  const root = tmpRoot()
  const r = checkEngineEnvShallow(fakeProfile(root, null), { rootDir: root })
  // ⛔ 折成 false 会让"名片还没接电"看起来像"环境坏了"，人会去装已经装好的东西；
  // ⛔ 折成 true 会让一张什么都没写的名片显示成"一切正常"。
  assert.equal(r.ok, null)
  assert.equal(r.unmanaged, true)
  assert.ok(r.problems.length > 0, '无从判断也要说清楚为什么，不能静默')
})

// ---------------------------------------------------------------------------
//  深层
// ---------------------------------------------------------------------------

test('深层：模块/类/方法都在，判「装了」', noPython, () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))

  const p = fakeProfile(root, {
    python: pythonRef(root), entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 60000, preload: false,
    verify: {
      sys_path: [],
      imports: [{ module: 'json', class: null, methods: [], init_params: [] },
        { module: 'argparse', class: 'ArgumentParser', methods: ['parse_args'], init_params: ['prog'] }],
    },
  })
  const r = checkEngineEnvDeep(p, { rootDir: root })
  assert.equal(r.ok, true, r.problems.join('\n'))
  assert.equal(r.level, 'deep')
  assert.ok(r.info.python.version, '要报出这是哪个解释器给的答案')
})

test('深层：模块导不进来判「没装」，并说清楚是哪个模块', noPython, () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))

  const p = fakeProfile(root, {
    python: pythonRef(root), entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 60000, preload: false,
    verify: { sys_path: [], imports: [{ module: 'aurivox_no_such_module', class: null, methods: [], init_params: [] }] },
  })
  const r = checkEngineEnvDeep(p, { rootDir: root })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /aurivox_no_such_module/)
})

test('深层：类在但方法不在，也要判「没装」（版本对不上就是这个形状）', noPython, () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))

  const p = fakeProfile(root, {
    python: pythonRef(root), entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 60000, preload: false,
    verify: {
      sys_path: [],
      imports: [{ module: 'argparse', class: 'ArgumentParser', methods: ['parse_args', 'method_that_never_existed'], init_params: [] }],
    },
  })
  const r = checkEngineEnvDeep(p, { rootDir: root })
  assert.equal(r.ok, false)
  assert.match(r.problems.join('\n'), /method_that_never_existed/)
})

test('⭐ 深层：sys_path 真的被塞进去了（GSV 少一条 sys.path 就 import 不了）', noPython, () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  // 一个只有加了 sys_path 才 import 得到的模块
  fs.mkdirSync(path.join(root, 'extra'), { recursive: true })
  fs.writeFileSync(path.join(root, 'extra', 'aurivox_only_here.py'), 'VALUE = 1\n')

  const withPath = fakeProfile(root, {
    python: pythonRef(root), entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 60000, preload: false,
    verify: { sys_path: ['extra'], imports: [{ module: 'aurivox_only_here', class: null, methods: [], init_params: [] }] },
  })
  const without = fakeProfile(root, {
    python: pythonRef(root), entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 60000, preload: false,
    verify: { sys_path: [], imports: [{ module: 'aurivox_only_here', class: null, methods: [], init_params: [] }] },
  })
  // 两条一起断言：只断言"加了能过"挡不住 sys_path 被忽略而模块恰好在别处，
  // 只断言"不加会红"挡不住 sys_path 根本没起作用。
  assert.equal(checkEngineEnvDeep(withPath, { rootDir: root }).ok, true, 'sys_path 没被塞进去')
  assert.equal(checkEngineEnvDeep(without, { rootDir: root }).ok, false, '不加 sys_path 竟然也能导进来，这条测试没有判别力')
})

test('深层：浅层不过就不起进程（解释器都不在，起它只会得到一句 ENOENT）', () => {
  const root = tmpRoot()
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false,
    verify: { sys_path: [], imports: [{ module: 'json', class: null, methods: [], init_params: [] }] },
  })
  const r = checkEngineEnvDeep(p, { rootDir: root })
  assert.equal(r.ok, false)
  assert.equal(r.level, 'shallow', '深层应该在浅层就返回，不该白起一次进程')
})

test('⭐ 深层：有 runtime 没 verify 判 null（能起，但无从核对装没装）', () => {
  const root = tmpRoot()
  touch(path.join(root, 'venv', 'bin', 'python'))
  touch(path.join(root, 'engines', 'demo', 'shim.py'))
  const p = fakeProfile(root, {
    python: 'venv/bin/python', entry: 'shim.py', args: [], cwd: null, checkpoints: null,
    ready_endpoint: '/', ready_timeout_ms: 1000, preload: false, verify: null,
  })
  const r = checkEngineEnvDeep(p, { rootDir: root })
  assert.equal(r.ok, null)
  assert.equal(r.unverifiable, true)
})

// ---------------------------------------------------------------------------
//  探针本身
// ---------------------------------------------------------------------------

test('探针「没装」时以 0 退出 —— 非零码要留给「探针自己出事」', noPython, () => {
  const out = spawnSync(PYTHON, [PROBE, '--spec',
    JSON.stringify({ imports: [{ module: 'aurivox_no_such_module' }] })], { encoding: 'utf8' })
  assert.equal(out.status, 0,
    '探针把"没装"报成非零退出，调用方就分不清"引擎没装"和"探针没跑起来"')
  assert.equal(JSON.parse(out.stdout).ok, false)
})

test('⛔ 守卫：探针只用标准库（它要在任意引擎的 venv 里跑，那里只有标准库）', () => {
  const src = fs.readFileSync(PROBE, 'utf8')
  const code = src.split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/"""[\s\S]*?"""/g, '')
  const mods = new Set()
  for (const m of code.matchAll(/^\s*(?:import|from)\s+([A-Za-z_][\w.]*)/gm)) {
    mods.add(m[1].split('.')[0])
  }
  const allowed = new Set(['json', 'sys', 'importlib', 'inspect', 'argparse', 'os', 'types', 'traceback'])
  for (const m of mods) {
    assert.ok(allowed.has(m),
      `env_probe.py import 了 ${m} —— 它要在任意引擎的 venv 里跑，那里不保证有第三方包`)
  }
  assert.ok(mods.size > 0, '一个 import 都没数出来 —— 这条守卫的正则失效了，它现在是摆设')
})

test('⛔ 守卫：这组测试自己不许用 symlink（Windows 非管理员会 EPERM）', () => {
  // ⭐ 这条守卫的由来：沙箱是 Linux，symlink 随便建；真机是 Windows，
  //   整组测试以 `EPERM: symlink` 挂掉，连带突变验证报"基线就是红的"。
  //   凡是文件系统的特权操作，沙箱结构上验不出真机会拒绝 —— 所以改成
  //   由一条守卫来管，而不是靠"下次记得别用"。
  const src = fs.readFileSync(__filename, 'utf8')
  // ⚠ 行注释和块注释都要滤掉。只滤 `//` 的话，上面 pythonRef 那段
  //   /** ... */ 里写的"原先是 symlink"会被自己抓住 —— 这条守卫第一次跑
  //   就是这么红的。（红得好：它证明了这条守卫真的在读正文。）
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  // ⚠ 拼出来而不是写死：守卫读的是本文件自己，写死会被自己抓到。
  const S = 'Sync'
  for (const bad of ['symlink' + S, 'fs.link' + S, 'chmod' + S, 'chown' + S]) {
    assert.ok(!code.includes(bad),
      `测试里用了 ${bad} —— Windows 上非管理员会直接失败，这组守卫会整个跑不起来`)
  }
  // 守卫自验：正则/读法要是失效了，上面那圈会静静地全过。
  assert.ok(code.includes('mkdtempSync'), '这条守卫读到的不是本文件的正文，它现在是摆设')
})

test('⛔ 守卫：envCheck 里不许出现任何装环境的动作（平台只验不建）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'envCheck.js'), 'utf8')
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  for (const bad of ['pip install', 'uv pip', 'micromamba', 'venv --', 'createvirtualenv', 'ensurepip']) {
    assert.ok(!code.toLowerCase().includes(bad.toLowerCase()),
      `envCheck.js 里出现了 "${bad}" —— 平台只验不建（Owner 2026-08-24 定案），装环境不是它的事`)
  }
})
