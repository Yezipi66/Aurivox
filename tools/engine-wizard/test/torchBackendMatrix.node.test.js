'use strict'
// 换后端装 torch 这条路的组合矩阵。
//
// 为什么单独一个文件：这条路只有在「使用者把后端从推荐值改成别的」时才走
//   （installChoices 的 lockRoute）。默认值是按硬件算的推荐后端，所以日常测试
//   和批量安装验证都不会走进去，cu121 那个坑就是这么漏到线上的：CUDA 索引写死在
//   表里，多年不跟 torch 版本校，而没人手点过后端下拉。
//
// 这里把「后端 × Python ABI」铺开逐个走一遍：
//   固定索引的后端，表里说没有轮子就必须拦住；有轮子的命令要用自己的 index。
//   CUDA 特殊：索引交给 uv 在安装时解析，平台不预判、不拦、也不挑档位，
//   只保证锁定版本原样、候选索引给全。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const envMod = require('../core/env.js')
const support = require('../core/backendTorchSupport.js')

const BACKENDS = ['cuda', 'ipex', 'rocm', 'cpu']
const PYS = ['3.9', '3.11', '3.13', '3.14']
const family = support.platformFamily(process.platform)
const abiOf = (v) => `cp${v.replace('.', '')}`
const indexUrlOf = (b) => `${support.PYTORCH_INDEX_ROOT}${support.BACKEND_INDEX[b]}`

const LOCK = [
  'version = 1', '',
  '[[package]]', 'name = "torch"', 'version = "2.6.0"',
  'source = { registry = "https://pypi.org/simple" }', '',
]

function engineWith (pyVersion) {
  const mkdtempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-matrix-'))
  const mkdtempEngines = path.join(mkdtempRoot, 'engines')
  const mkdtempEngineDir = path.join(mkdtempEngines, `m-${pyVersion.replace('.', '')}`)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  fs.writeFileSync(path.join(mkdtempRoot, 'server.js'), '// anchor\n')
  fs.writeFileSync(path.join(mkdtempEngineDir, 'uv.lock'), LOCK.join('\n'))
  fs.writeFileSync(path.join(mkdtempEngineDir, '.python-version'), `${pyVersion}\n`)
  return { root: mkdtempRoot, id: `m-${pyVersion.replace('.', '')}` }
}

/** 换后端那条分支：recommendedBackend 必须与所选后端不同，否则不进这道判据。 */
function planFor (backend, pyVersion) {
  const { root, id } = engineWith(pyVersion)
  const other = backend === 'cpu' ? 'ipex' : 'cpu'
  return envMod.buildEnvPlan({
    id, root, manifest: {}, backend, recommendedBackend: other,
  })
}

test('⭐⭐⭐ 后端 × ABI 全组合：固定索引拦得准，CUDA 交给 uv 解析', () => {
  const checked = []
  for (const b of BACKENDS) {
    for (const v of PYS) {
      const p = planFor(b, v)
      checked.push(`${b}/${v}`)
      if (b === 'cuda') {
        assert.strictEqual(p.ok, true,
          `CUDA 不该由平台预判 ${v} 能不能装，那该问 uv：${p.errorZh || p.error}`)
        const argv = [
          ...(p.steps || []).flatMap((s) => s.argv || []),
          ...((p.alternative || {}).then || []),
        ]
        assert.ok(argv.includes('torch==2.6.0'), '锁定版本要原样进命令')
        assert.ok(argv.includes('unsafe-best-match'), '要让 uv 跨索引解析')
        for (const index of support.CUDA_INDEX_CANDIDATES) {
          assert.ok(argv.some((a) => String(a).endsWith(`/whl/${index}`)),
            `CUDA + ${v} 没把候选索引 ${index} 给 uv`)
        }
        continue
      }
      const min = support.minTorchFor(b, abiOf(v), family)
      if (!min) {
        assert.strictEqual(p.ok, false, `${b} + ${v} 表里没有轮子，却给出了计划`)
        assert.strictEqual(p.code, 'BACKEND_NO_TORCH_WHEEL')
        assert.ok(!JSON.stringify(p.steps || []).includes('--index-url'),
          '被拦住的组合不许留下任何装 torch 的命令')
        continue
      }
      assert.strictEqual(p.ok, true, `${b} + ${v} 表里有轮子（${min}），计划却失败了：${p.errorZh || p.error}`)
      const cmd = JSON.stringify(p.steps || [])
      if (cmd.includes('--index-url')) {
        assert.ok(cmd.includes(indexUrlOf(b)),
          `${b} 后端装 torch 时应当用自己的索引 ${indexUrlOf(b)}，实际：${cmd.slice(0, 200)}`)
      }
    }
  }
  assert.ok(checked.length >= BACKENDS.length * PYS.length)
})

test('⭐⭐⭐ 人选版本压过目录声明：CUDA 不再拿目录声明预判，版本仍原样锁定', () => {
  const { root, id } = engineWith('3.13')
  const p = envMod.buildEnvPlan({
    id, root, manifest: {}, backend: 'cuda', recommendedBackend: 'cpu',
    pythonVersion: '3.8',
  })
  assert.strictEqual(p.ok, true, p.errorZh || p.error)
  const argv = [
    ...(p.steps || []).flatMap((s) => s.argv || []),
    ...((p.alternative || {}).then || []),
  ]
  assert.ok(argv.includes('torch==2.6.0'), '锁定的 torch 版本不许被改')
  assert.ok(argv.includes('unsafe-best-match'))
})

test('⭐⭐ cu121 那个坑的收尾：平台不再靠一张静态表避开它', () => {
  assert.strictEqual(support.minTorchFor('cuda', 'cp311', 'win'), null)
  assert.ok(support.CUDA_INDEX_CANDIDATES.includes('cu121'))
  assert.ok(support.CUDA_INDEX_CANDIDATES.includes('cu126'))
  assert.strictEqual(support.BACKEND_INDEX.cuda, 'cu126', '兜底值仍在，但拼命令不认死它')
})
