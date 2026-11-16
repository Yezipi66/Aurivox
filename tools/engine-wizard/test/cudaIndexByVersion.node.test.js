'use strict'
// CUDA 不给用户挑档位，也不在本地存「哪个 torch 版本对应哪个 cuXXX」。
//
// 那张表是各索引页事实的抄本：会过期、会抄错、还要人跟着 torch 发版维护。
// 正确做法是把版本锁死、把全部官方候选索引交给 uv，用它自己的解析算法
// 按锁定版本 + 目标 ABI + 平台 + 依赖链挑出能装的那一档。
// 唯一例外：锁文件明写 +cu121（GSV v2 这种）时照抄上游，只给那一个索引。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const support = require('../core/backendTorchSupport.js')
const envMod = require('../core/env.js')
const probe = require('../core/torchVersionProbe.js')

const WIN = { family: 'win' }
const opts = (abi, extra = {}) => ({ ...WIN, abi, ...extra })

const CANDIDATES = ['cu118', 'cu121', 'cu124', 'cu126', 'cu128', 'cu130']

test('⭐⭐⭐ CUDA 不挑档位：给 uv 全部候选索引 + 跨索引解析策略', () => {
  const args = support.cudaIndexArgs(null)
  assert.ok(args.includes('--index-strategy'))
  assert.strictEqual(args[args.indexOf('--index-strategy') + 1], 'unsafe-best-match')
  assert.strictEqual(args[args.indexOf('--index-url') + 1],
    `${support.PYTORCH_INDEX_ROOT}${CANDIDATES[0]}`)
  for (const index of CANDIDATES) {
    assert.ok(args.includes(`${support.PYTORCH_INDEX_ROOT}${index}`),
      `候选索引 ${index} 没给 uv，解析器看不全`)
  }
  assert.ok(!args.includes('https://pypi.org/simple'),
    '不要把 PyPI 塞进来：torch 的普通依赖在官方 CUDA index 上就有')
})

test('⭐⭐⭐ 本地不许再存「版本到 CUDA 档位」的映射表', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'core', 'backendTorchSupport.js'), 'utf8')
  assert.ok(!/CUDA_INDEX_WHEELS|minTorchForIndex|cudaIndexFor|cudaIndexesFor/.test(src),
    '本地映射表又回来了：那份事实已经在索引页上，抄一份只会过期')
  assert.strictEqual(support.minTorchFor('cuda', 'cp313', 'win'), null,
    'CUDA 没有固定下界可查，判据在安装时由 uv 给')
})

test('⭐⭐⭐ GSV v2：锁文件明写 +cu121 时只给那一个索引，照抄上游', () => {
  const args = support.cudaIndexArgs('cu121')
  assert.deepStrictEqual(args, ['--index-url', 'https://download.pytorch.org/whl/cu121'])
  assert.ok(!args.includes('unsafe-best-match'), '明写档位时不许让 uv 换档')
})

test('⭐⭐ 剥版本后缀的工具仍在（+cu121 / +xpu）', () => {
  assert.strictEqual(support.torchVersionOf('2.2.0+cu121'), '2.2.0')
  assert.strictEqual(support.torchVersionOf('2.6.0+xpu'), '2.6.0')
  assert.strictEqual(support.torchVersionOf('not-a-version'), null)
})

function engineWith (version, pyVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-cuda-'))
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(root, 'server.js'), '// anchor\n')
  const src = /\+cu/.test(version) ? 'https://pypi.org/simple' : 'https://pypi.org/simple'
  fs.writeFileSync(path.join(dir, 'uv.lock'), [
    'version = 1', '', '[[package]]', 'name = "torch"', `version = "${version}"`,
    `source = { registry = "${src}" }`, '',
  ].join('\n'))
  fs.writeFileSync(path.join(dir, '.python-version'), `${pyVersion}\n`)
  return { root, id: 'demo' }
}

function planFor (version, pyVersion, backend = 'cuda') {
  const { root, id } = engineWith(version, pyVersion)
  return envMod.buildEnvPlan({
    id, root, manifest: {}, backend, recommendedBackend: 'cpu',
  })
}

function allArgv (plan) {
  return [
    ...(plan.steps || []).flatMap((s) => s.argv || []),
    ...((plan.alternative || {}).then || []),
  ]
}

test('⭐⭐⭐ 端到端：锁 torch 2.2.0 + 选 CUDA，版本原样、候选索引全给 uv', () => {
  const p = planFor('2.2.0', '3.11')
  assert.strictEqual(p.ok, true, p.errorZh || p.error)
  const argv = allArgv(p)
  assert.ok(argv.includes('torch==2.2.0'), '版本必须原样锁死')
  assert.ok(!argv.some((a) => /torch==2\.6\.0/.test(String(a))), '不许抬版本')
  assert.ok(argv.includes('unsafe-best-match'), '要让 uv 跨索引解析')
  for (const index of CANDIDATES) {
    assert.ok(argv.some((a) => String(a).endsWith(`/whl/${index}`)),
      `候选索引 ${index} 没进命令`)
  }
})

test('⭐⭐⭐ 端到端：Python 3.14 也照样给命令，判据留给安装时的 uv', () => {
  const p = planFor('2.6.0', '3.14')
  assert.strictEqual(p.ok, true, p.errorZh || p.error)
  const argv = allArgv(p)
  assert.ok(argv.includes('torch==2.6.0'))
  assert.ok(argv.includes('unsafe-best-match'))
})

test('⭐⭐⭐ 端到端：GSV v2 锁 2.2.0+cu121 且后端是 cuda，不重拼 torch 命令', () => {
  // 锁文件里的 source 已经写明索引，后端也一致 ⇒ 照 uv.lock 装即可。
  //   平台若在这里再插一条 --index-url，反而可能把上游钉的档位换掉。
  const p = planFor('2.2.0+cu121', '3.11')
  assert.strictEqual(p.ok, true, p.errorZh || p.error)
  const argv = allArgv(p)
  assert.ok(!argv.includes('--index-url'), '不该重拼 torch 命令')
  assert.ok(!argv.includes('unsafe-best-match'))
  assert.ok(argv.some((a) => String(a) === 'sync'), '应当照锁文件走 uv sync')
})

test('⭐⭐⭐ judgeTorchVersion 对 CUDA 一律不弹「升级 torch」', () => {
  const { root } = engineWith('2.2.0', '3.11')
  const dir = path.join(root, 'engines', 'demo')
  for (const py of ['3.11', '3.13', '3.14']) {
    const r = probe.judgeTorchVersion({
      dir, backend: 'cuda', pythonVersion: py, platform: 'win32',
    })
    assert.strictEqual(r, null,
      `Python ${py} 不该由平台预判 CUDA 能不能装，那该问 uv`)
  }
})

test('⭐⭐ 其它后端仍是固定索引，不受 CUDA 分支影响', () => {
  assert.strictEqual(support.minTorchFor('cpu', 'cp312', 'win'), '2.2.0')
  assert.strictEqual(support.minTorchFor('ipex', 'cp311', 'win'), '2.6.0')
  const { BACKEND_PREFERENCE } = require('../core/hardware.js')
  assert.strictEqual(BACKEND_PREFERENCE.find((b) => b.key === 'cpu').index,
    'https://download.pytorch.org/whl/cpu')
  const p = planFor('2.6.0', '3.11', 'cpu')
  assert.strictEqual(p.ok, true, p.errorZh || p.error)
  assert.ok(!allArgv(p).includes('unsafe-best-match'), 'CPU 后端不需要跨索引解析')
})
