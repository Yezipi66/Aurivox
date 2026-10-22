'use strict'
// 依赖清单解析的行为测试：覆盖 requirements.txt、pyproject.toml 与 setup.py 三种来源。
// 判据：读出的包名与 spec 必须原样可用；读不出的东西不许被猜成包名或版本。
// 解析与判定都在 tools/engine-wizard/core/probe.js，本文件只验证它的行为。

const { test } = require('node:test')
const assert = require('node:assert')

const {
  parseRequirements, planDependencies, probeProject, parseSetupPyName,
} = require('../core/probe.js')

// 夹具：按真实项目的常见形态写的 requirements.txt。
const REQ = [
  '--index-url https://pypi.org/simple',
  '',
  '# 运行时依赖',
  '-r base.txt',
  '-c constraints.txt',
  '-e .',
  '',
  'torch==2.2.0',
  'torchaudio==2.2.0',
  'torchvision==0.17.0',
  'fastapi[all]>=0.100',          // extras ⇒ 包名是 fastapi
  'librosa; python_version<"3.9"',  // 环境标记 ⇒ 取分号前
  'numpy==1.24.0  # 钉住版本',      // 行尾注释 ⇒ 剥掉
  'onnxruntime-gpu',                // 无版本约束
  'git+https://github.com/owner/pkg.git#egg=pkg',   // 直连来源
  'file:///opt/local/wheelhouse',                   // 直连来源
  'https://example.invalid/pkg-1.0.tar.gz',         // 直连来源
  '--find-links ./wheels',
  '--hash=sha256:abcdef',
  '',
  'openssl==3.0.1 \\',              // 续行：本行不是一条完整依赖
  '  --hash=sha256:123456',
  '',
  'torch>=2.5.0',                   // 重复声明 ⇒ 去重，保留第一次
].join('\n')

test('parseRequirements：== / >= / 无版本 三种形态都读出包名', () => {
  const r = parseRequirements(REQ)
  assert.strictEqual(r.found, true)
  assert.ok(r.dependencies.includes('torch'), JSON.stringify(r.dependencies))
  assert.ok(r.dependencies.includes('onnxruntime-gpu'), '无版本约束也该读出')
  assert.deepStrictEqual(
    r.dependencies,
    ['torch', 'torchaudio', 'torchvision', 'fastapi', 'librosa', 'numpy',
      'onnxruntime-gpu'],
    `实际读出：${JSON.stringify(r.dependencies)}`)
})

test('parseRequirements：包名与版本串成对，第 2 步要的是版本不是名字', () => {
  const r = parseRequirements(REQ)
  assert.strictEqual(r.dependencies.length, r.specs.length)
  const byName = new Map(r.dependencies.map((n, i) => [n.toLowerCase(), r.specs[i]]))
  // 钉住版本的那条必须原样带出版本约束（后端判定靠的就是这个）。
  assert.strictEqual(byName.get('torch'), 'torch==2.2.0')
  assert.strictEqual(byName.get('numpy'), 'numpy==1.24.0',
    '⛔ 行尾注释不许留在 spec 里')
  // extras 与约束之间多写的空格要归一（后端要的是规范形状）。
  assert.strictEqual(byName.get('fastapi'), 'fastapi[all]>=0.100')
  // 裸包名 ⇒ spec 就是包名，不许补一个假的版本号。
  assert.strictEqual(byName.get('onnxruntime-gpu'), 'onnxruntime-gpu')
})

test('parseRequirements：extras 剥掉 []，包名就是包名', () => {
  const r = parseRequirements('fastapi[all]>=0.100\nhttpx[cli]>=0.27\n')
  assert.deepStrictEqual(r.dependencies, ['fastapi', 'httpx'])
  assert.ok(!r.dependencies.some((n) => n.includes('[')), 'extras 没剥掉')
})

test('parseRequirements：环境标记只取分号前', () => {
  const r = parseRequirements('librosa; python_version<"3.9"\nnumpy; sys_platform=="linux"\n')
  assert.deepStrictEqual(r.dependencies, ['librosa', 'numpy'])
  assert.deepStrictEqual(r.specs, ['librosa', 'numpy'],
    '⛔ spec 不许带上环境标记（那是条件，不是依赖）')
})

test('parseRequirements：-r / -e / -c / --index-url / --find-links / --hash 全跳过', () => {
  const r = parseRequirements([
    '-r base.txt', '-e .', '-c constraints.txt',
    '--index-url https://pypi.org/simple', '--extra-index-url https://x.invalid',
    '--find-links ./wheels', '--no-binary :all:',
    '--trusted-host pypi.org',
  ].join('\n'))
  assert.deepStrictEqual(r.dependencies, [],
    `选项行不许被读成依赖：${JSON.stringify(r.dependencies)}`)
  assert.strictEqual(r.skipped, 8)
})

test('parseRequirements：空行与 # 注释跳过', () => {
  const r = parseRequirements('\n\n# 只有注释\n   # 缩进注释\n\n')
  assert.strictEqual(r.found, true, '⛔ 文件本身存在 ⇒ found 为 true')
  assert.deepStrictEqual(r.dependencies, [])
})

test('parseRequirements：直连来源不是普通依赖（不编成包名）', () => {
  const r = parseRequirements([
    'git+https://github.com/owner/pkg.git#egg=pkg',
    'file:///opt/local/wheelhouse',
    'https://example.invalid/pkg-1.0.tar.gz',
    './local/dir',
    'pkg @ https://example.invalid/pkg.whl',
  ].join('\n'))
  assert.deepStrictEqual(r.dependencies, [], JSON.stringify(r.dependencies))
})

test('parseRequirements：续行不是一条独立依赖', () => {
  const r = parseRequirements([
    'openssl==3.0.1 \\',
    '    --hash=sha256:123456',
    'torch==2.2.0',
  ].join('\n'))
  assert.deepStrictEqual(r.dependencies, ['torch'],
    `续行不应产生第二个依赖：${JSON.stringify(r.dependencies)}`)
})

test('parseRequirements：重复声明去重，保留第一次', () => {
  const r = parseRequirements('torch==2.2.0\ntorch>=2.5.0\nTorch==2.3.0\n')
  assert.deepStrictEqual(r.dependencies, ['torch'])
  assert.strictEqual(r.specs.length, 1)
  assert.strictEqual(r.specs[0], 'torch==2.2.0', '保留第一次的约束')
})

test('parseRequirements：null / 非字符串 / 空串不能炸，且 found 为 false', () => {
  for (const bad of [null, undefined, 42, {}, [], '']) {
    const r = parseRequirements(bad)
    assert.strictEqual(r.found, false, `${JSON.stringify(bad)} 不该是 found`)
    assert.deepStrictEqual(r.dependencies, [])
    assert.deepStrictEqual(r.specs, [])
  }
})


test('parseRequirements 遇 pyproject 文本不乱报依赖', () => {
  const PYPROJECT = `
[project]
name = "speechkit"
license = "Apache-2.0"
requires-python = ">=3.10"
dependencies = [
    "torch>=2.5.0",
    "torchaudio>=2.5.0",
]
[project.scripts]
speechkit = "speechkit.cli:main"
`
  const r = parseRequirements(PYPROJECT)
  assert.deepStrictEqual(r.dependencies, [],
    `⛔ pyproject 不该被读出依赖：${JSON.stringify(r.dependencies)}`)
  // project / name / license 这类行不是依赖声明。
  for (const wrong of ['project', 'name', 'license', 'speechkit', 'speechkit.cli']) {
    assert.ok(!r.dependencies.includes(wrong), `误报「${wrong}」`)
  }
})

test('不是依赖声明的行不许被猜成包名', () => {
  // 一行里出现两个词、又不是版本约束 ⇒ 不是依赖声明，跳过。
  const r = parseRequirements('foo bar\nthis is prose, not a dependency\npython3 setup.py\n')
  assert.deepStrictEqual(r.dependencies, [],
    `⛔ 把散文读成包名了：${JSON.stringify(r.dependencies)}`)
})



test('走 requirements 路径：出 torch 判定（hardware judge），不再是 ok:false', () => {
  const plan = planDependencies(null, {
    hardware: { recommended: 'ipex', gpus: [] },
    requirements: REQ,
  })
  assert.strictEqual(plan.ok, true, plan.errorZh || plan.error)
  assert.strictEqual(plan.dep_source, 'requirements.txt')
  assert.strictEqual(plan.dep_count, 7)
  assert.strictEqual(plan.deps.total, 7)

  // torch 系被摘出来单独判：
  //   torch / torchaudio / torchvision / onnxruntime-gpu 都在 TORCH_FAMILY 里，
  //   共 4 条；其余 3 条归「普通依赖」。
  assert.strictEqual(plan.deps.torch.count, 4)
  const main = plan.deps.torch.packages.find((p) => p.isMain)
  assert.ok(main, '⛔ 没有 isMain 的 torch 行')
  assert.strictEqual(main.spec, 'torch==2.2.0',
    '⛔ spec 必须是 requirements 里那行（带版本），不是裸包名')
  // 钉死版本 ⇒ judgeTorchSpec 给出确定结论（cpu，与本机匹配）。
  assert.strictEqual(main.verdict, 'match', main.why)
  assert.strictEqual(plan.verdict, 'match')
  // 其余依赖归「普通依赖」。
  assert.strictEqual(plan.deps.normal.count, 3)
})

test('带 +cu 后端的那条 ⇒ mismatch（真的判了，不是原样透传）', () => {
  const plan = planDependencies(null, {
    hardware: { recommended: 'ipex', gpus: [] },
    requirements: 'torch==2.2.0+cu121\nnumpy==1.24.0\n',
  })
  assert.strictEqual(plan.ok, true)
  const main = plan.deps.torch.packages.find((p) => p.isMain)
  assert.strictEqual(main.verdict, 'mismatch')
  assert.ok(main.why.includes('ipex'), main.why)
  assert.ok(main.whyZh && main.whyZh.length > 0, '⛔ 必须有中文理由')
})

test('没检测本机 ⇒ 判 unknown（不猜），但依赖照样读出', () => {
  const plan = planDependencies(null, { requirements: 'torch==2.2.0\nnumpy\n' })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.hardware, null)
  const main = plan.deps.torch.packages.find((p) => p.isMain)
  assert.strictEqual(main.verdict, 'unknown')
})

test('两份清单都没有 ⇒ 如实说读不到（不编造、不说「换仓库」）', () => {
  const plan = planDependencies(null, {})
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'NO_DEPENDENCIES')
  assert.strictEqual(plan.dep_source, null)
  assert.ok(/requirements\.txt/.test(plan.errorZh), plan.errorZh)
  assert.ok(/requirements\.txt/.test(plan.error), plan.error)
  // 旧文案那句「请换一份带依赖清单的仓库」不该再出现。
  assert.ok(!/换一份/.test(plan.errorZh), plan.errorZh)
})

test('requirements.txt 在、但每一行都读不出 ⇒ 如实说「没读到依赖行」', () => {
  const plan = planDependencies(null, {
    requirements: '-r base.txt\n# 只有注释\n\ngit+https://x.invalid/a.git\n',
  })
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'NO_DEPENDENCIES')
  assert.ok(/requirements\.txt/.test(plan.errorZh), plan.errorZh)
})



const GOOD_PYPROJECT = `
[project]
name = "speechkit"
license = "Apache-2.0"
requires-python = ">=3.10"
dependencies = [
    "torch>=2.5.0",
    "torchaudio>=2.5.0",
]

[project.scripts]
speechkit = "speechkit.cli:main"

[tool.setuptools.packages.find]
where = ["src"]
`

test('回归：老调用 planDependencies(pyprojectText, {hardware}) 行为不变', () => {
  const plan = planDependencies(GOOD_PYPROJECT, {
    hardware: { recommended: 'ipex', gpus: [] },
  })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.dep_source, 'pyproject.toml')
  assert.strictEqual(plan.deps.total, 2)
  assert.strictEqual(plan.deps.torch.count, 2)
  const main = plan.deps.torch.packages.find((p) => p.isMain)
  assert.strictEqual(main.spec, 'torch>=2.5.0')
  // pyproject 只写 >=，判不出后端 ⇒ unknown
  assert.strictEqual(main.verdict, 'unknown')
  assert.strictEqual(plan.deps.normal.count, 0)
})

test('回归：pyproject 优先于 requirements（不是「随便挑一个」）', () => {
  const plan = planDependencies(GOOD_PYPROJECT, {
    hardware: { recommended: 'ipex', gpus: [] },
    requirements: 'librosa==0.10.0\nsoundfile==0.12.0\n',
  })
  assert.strictEqual(plan.dep_source, 'pyproject.toml',
    '⛔ 两个都有时必须走 pyproject，否则会读到 pyproject 没声明的包')
  assert.strictEqual(plan.deps.total, 2)
  assert.ok(!plan.deps.normal.packages.includes('librosa'),
    '⛔ requirements 的包混进来了')
})

test('回归：pyproject 在但没有 dependencies ⇒ 退回 requirements', () => {
  const noDeps = `
[build-system]
requires = ["setuptools"]
`
  const plan = planDependencies(noDeps, {
    hardware: { recommended: 'ipex', gpus: [] },
    requirements: 'torch==2.2.0\n',
  })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.dep_source, 'requirements.txt')
})

test('回归：planDependencies(null, {requirements}) 不炸', () => {
  const plan = planDependencies(null, { requirements: 'torch==2.2.0\n' })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.deps.torch.count, 1)
})



const SETUP_PY = [
  'from setuptools import setup, find_packages',
  '',
  'setup(',
  '    name="speechkit",',
  '    version="0.1.0",',
  '    packages=find_packages(),',
  ')',
].join('\n')

test('setup.py 的 name= 能读出包名（没有 pyproject 也读）', () => {
  const name = parseSetupPyName(SETUP_PY)
  assert.strictEqual(name, 'speechkit')
})

test('setup.py 只读文本：没有 name= 就返回 null（不猜）', () => {
  assert.strictEqual(parseSetupPyName('from setuptools import setup\nsetup(version="1")\n'),
    null)
  for (const bad of [null, undefined, 42, {}, '']) {
    assert.strictEqual(parseSetupPyName(bad), null)
  }
})

test('第 1 步：缺 pyproject 时，包名与许可证不再全空', () => {
  const r = probeProject({
    pyproject: undefined,
    requirements: REQ,
    setupPy: SETUP_PY,
    licenseFile: 'LICENSE',
    filenames: ['requirements.txt', 'setup.py'],
  })
  assert.strictEqual(r.values['call.module'], 'speechkit',
    '⛔ 包名读不出来（来源是 setup.py，不是 pyproject）')
  assert.ok(r.sources['call.module'].includes('setup.py'))
  // 许可证「值」与「来源」必须一致：只有文件、没有标识时，
  //   值是 null（不装句子），事实由 licenseEvidence 承载。
  assert.strictEqual(r.meta.license, null,
    `⛔ 许可证值里装了句子（这个字段会直接渲染到界面）：${r.meta.license}`)
  assert.strictEqual(r.meta.licenseFrom, null,
    '⛔ 没有许可证标识却声称了来源')
  assert.strictEqual(r.meta.licenseEvidence, 'file-only')
  assert.strictEqual(r.meta.licenseFile, 'LICENSE')
  // 依赖清单照样认得出
  assert.strictEqual(r.meta.dependencies.primary.kind, 'requirements')
  assert.deepStrictEqual(r.meta.requirementPackages.length, 7)
  // 许可证类型不许被猜出来（只报「有 LICENSE 文件」）
  assert.ok(!/Apache|MIT|GPL|BSD/.test(String(r.meta.license)),
    `⛔ 猜了许可证类型：${r.meta.license}`)
  assert.ok(!/Apache|MIT|GPL|BSD/.test(String(r.meta.licenseEvidence)),
    `⛔ 事实字段里猜了许可证类型：${r.meta.licenseEvidence}`)
})

test('pyproject 写了 license ⇒ 优先用它（比文件存在更精确）', () => {
  const r = probeProject({
    pyproject: GOOD_PYPROJECT,
    licenseFile: 'LICENSE',
    filenames: ['pyproject.toml'],
  })
  assert.strictEqual(r.meta.license, 'Apache-2.0')
  assert.strictEqual(r.meta.licenseFrom, 'pyproject.toml [project.license]')
  assert.strictEqual(r.meta.licenseEvidence, 'identifier')
  assert.strictEqual(r.values['call.module'], 'speechkit')
})

// 值与来源必须一致：StepPrepare.jsx 把 meta.packageName 与 meta.license
// 直接渲染到界面上，而 meta.*From 也在响应里。值字段一旦被塞进句子，
// 那句话就会原样显示。判据：packageName / packageNameFrom / license / licenseFrom
// 有值与有来源必须同进同出。

/**
 * 判断一个值字段是不是被塞进了句子。
 * @returns {string|null} 是句子就返回原值，否则返回 null。
 */
function sentenceIn (v) {
  if (v == null) return null
  return /\s/.test(String(v).trim()) && !/^[\w.+-]+$/.test(String(v).trim())
    ? String(v) : null
}

test('值字段不许装句子：许可证/包名都是标识，不是描述', () => {
  const cases = [
    probeProject({ filenames: ['README.md'] }),
    probeProject({ requirements: REQ, licenseFile: 'LICENSE' }),
    probeProject({ requirements: REQ, licenseFile: 'COPYING' }),
    probeProject({ pyproject: GOOD_PYPROJECT, licenseFile: 'LICENSE' }),
  ]
  for (const r of cases) {
    for (const k of ['license', 'packageName', 'licenseEvidence']) {
      const bad = sentenceIn(r.meta[k])
      assert.strictEqual(bad, null,
        `⛔ meta.${k} 装了一句句子（会直接显示在界面上）：${bad}`)
    }
  }
})

test('没有值就不许声称来源：packageName / license 三个字段同进同出', () => {
  const cases = [
    probeProject({ filenames: ['README.md'] }),
    probeProject({ requirements: REQ, licenseFile: 'LICENSE' }),
    probeProject({ requirements: REQ }),
    probeProject({ pyproject: GOOD_PYPROJECT, licenseFile: 'LICENSE' }),
  ]
  for (const r of cases) {
    for (const [value, from] of [
      [r.meta.packageName, r.meta.packageNameFrom],
      [r.meta.license, r.meta.licenseFrom],
    ]) {
      if (value == null) {
        assert.strictEqual(from, null,
          `⛔ 值是空的却声称了来源「${from}」（界面上读起来像读到了）`)
      } else {
        assert.ok(typeof from === 'string' && from.length > 0,
          `⛔ 有值却没有来源：${value}`)
      }
    }
  }
})

test('老式布局（只有 requirements.txt + LICENSE）⇒ 包名与来源都不许撒谎', () => {
  // 上游根目录既没有 pyproject.toml 也没有 setup.py 的布局：
  // 确实读不到包名，那就如实留空，不许声称「来自 pyproject.toml」。
  const r = probeProject({
    requirements: REQ,
    licenseFile: 'LICENSE',
    filenames: ['requirements.txt'],
  })
  assert.strictEqual(r.meta.packageName, null)
  assert.strictEqual(r.meta.packageNameFrom, null)
  assert.strictEqual(r.meta.license, null)
  assert.strictEqual(r.meta.licenseFrom, null)
  assert.strictEqual(r.meta.licenseEvidence, 'file-only')
  assert.ok(!('call.module' in r.values))
})

test('什么来源都没有 ⇒ 如实留空，不猜包名与许可证', () => {
  const r = probeProject({ filenames: ['README.md'] })
  assert.ok(!('call.module' in r.values))
  assert.strictEqual(r.meta.packageName, null)
  assert.strictEqual(r.meta.license, null)
  assert.strictEqual(r.meta.licenseFile, null)
  assert.ok(r.unfilled.some((u) => u.key === 'call.module'))
})

test('pyproject 优先：pyproject 有 name 时不许被 setup.py 覆盖', () => {
  const r = probeProject({
    pyproject: GOOD_PYPROJECT,
    setupPy: 'setup(name="othername")',
    filenames: ['pyproject.toml', 'setup.py'],
  })
  assert.strictEqual(r.values['call.module'], 'speechkit')
  assert.ok(r.sources['call.module'].includes('pyproject'))
})



test('依赖来源相关的用户可见文案不许有 emoji / 破折号 / 口语', () => {
  const FORBIDDEN = ['\u26d4', '——', '对得上', '看不出来', '没什么', '搞定',
    '拿掉', '弄坏', '平台不替你猜', '这不是错', '请换一份']
  const seen = []
  const noPy = planDependencies(null, {})
  seen.push(noPy.error, noPy.errorZh)
  const emptyReq = planDependencies(null, { requirements: '-r a.txt\n' })
  seen.push(emptyReq.error, emptyReq.errorZh)
  for (const s of seen) {
    for (const bad of FORBIDDEN) {
      assert.ok(!s.includes(bad), `文案里出现了「${bad}」：${s}`)
    }
  }
})

test('成功响应必须说清依赖是从哪个文件读出来的', () => {
  for (const plan of [
    planDependencies(GOOD_PYPROJECT, {}),
    planDependencies(null, { requirements: 'torch==2.2.0\n' }),
  ]) {
    assert.strictEqual(plan.ok, true)
    assert.ok(['pyproject.toml', 'requirements.txt'].includes(plan.dep_source),
      `dep_source 不对：${plan.dep_source}`)
    assert.strictEqual(typeof plan.dep_count, 'number')
  }
})