'use strict'

// ---------------------------------------------------------------------------
//  安装计划 —— 契约 §12 第 4 步：按名片钉住的 commit 拉上游
// ---------------------------------------------------------------------------
// buildInstallPlan 是纯函数：它只**算出**该跑哪几条命令，一个字节都不写盘。
// 真正执行在 tools/install-engine.cjs 里。分开是为了让「装引擎该怎么装」
// 这件事可以被测试，而不用真的下几个 GB。
//
// ⛔ 本文件不在 engines/ 下造临时引擎目录：那里有目录清点守卫，
//    并发跑测试时会互相打架。所有名片都是内存里现造的对象。

const test = require('node:test')
const assert = require('node:assert')

const { buildInstallPlan, parseInstall, InstallPlanError } = require('./installPlan')

const SHA = 'a'.repeat(40)

function profileOf(over = {}) {
  return {
    id: 'demo',
    label: 'Demo',
    upstream: { url: 'https://example.invalid/demo.git', commit: SHA, license: 'MIT' },
    ...over,
  }
}

function subs(plan) {
  return plan.steps.map((s) => s.kind)
}

// --------------------------- 正常路径 ---------------------------

test('钉住了 commit：算出 init → remote → fetch → checkout → drop-git 五步', () => {
  const plan = buildInstallPlan(profileOf(), {})
  assert.deepEqual(subs(plan), ['init', 'remote', 'fetch', 'checkout', 'drop-git'])
  assert.equal(plan.commit, SHA)
  assert.equal(plan.dir, 'engines/demo')
})

test('⛔ 不用 git clone —— 名片已经躺在目标目录里，clone 拒绝拉进非空目录', () => {
  const plan = buildInstallPlan(profileOf(), {})
  const flat = plan.steps.filter((s) => s.argv).map((s) => s.argv.join(' ')).join('\n')
  assert.ok(!/git clone/.test(flat),
    `计划里出现了 git clone，它会在「目录里已有 manifest.json」时直接失败：\n${flat}`)
})

test('checkout 钉的是 sha 本身，且是 --detach（不建分支）', () => {
  const plan = buildInstallPlan(profileOf(), {})
  const co = plan.steps.find((s) => s.kind === 'checkout')
  assert.deepEqual(co.argv, ['git', 'checkout', '--detach', SHA])
})

test('每一条 git 都在引擎目录里跑，不在仓库根上乱跑', () => {
  const plan = buildInstallPlan(profileOf(), {})
  for (const s of plan.steps) {
    if (s.argv && s.argv[0] === 'git') {
      assert.equal(s.cwd, 'engines/demo', `${s.argv.join(' ')} 跑在了 ${s.cwd}`)
    }
  }
})

test('最后一步是删掉上游的 .git（C10：不进 git、不做嵌套仓库）', () => {
  const plan = buildInstallPlan(profileOf(), {})
  const last = plan.steps[plan.steps.length - 1]
  assert.equal(last.kind, 'drop-git')
  assert.equal(last.remove, 'engines/demo/.git')
})

test('要联网的步骤被标出来了（用的人该知道哪一步会下几个 GB）', () => {
  const plan = buildInstallPlan(profileOf(), {})
  assert.ok(plan.steps.find((s) => s.kind === 'fetch').needs_network)
})

test('收尾指向三道校验 —— 源码到位 ≠ 能出声', () => {
  const plan = buildInstallPlan(profileOf(), {})
  assert.match(plan.verify_hint, /check-engine-env/)
})

// --------------------------- install 段 ---------------------------

test('名片写了 install.env_command，就多一步建环境，排在删 .git 之后', () => {
  const plan = buildInstallPlan(profileOf(), { install: { env_command: ['uv', 'sync'] } })
  assert.deepEqual(subs(plan), ['init', 'remote', 'fetch', 'checkout', 'drop-git', 'env'])
  const env = plan.steps[5]
  assert.deepEqual(env.argv, ['uv', 'sync'])
  assert.equal(env.cwd, 'engines/demo')
})

test('没写 install 段也能装 —— 有些引擎克隆下来就能用', () => {
  const plan = buildInstallPlan(profileOf(), {})
  assert.ok(!plan.steps.some((s) => s.kind === 'env'))
})

test('env_command 写成字符串要报错（必须是数组，不然带空格的路径会被拆开）', () => {
  assert.throws(() => parseInstall({ install: { env_command: 'uv sync' } }),
    (err) => err instanceof InstallPlanError)
})

test('env_command 是空数组要报错（写了等于没写，比不写更糟）', () => {
  assert.throws(() => parseInstall({ install: { env_command: [] } }),
    (err) => err instanceof InstallPlanError)
})

test('env_command 里混了非字符串要报错', () => {
  assert.throws(() => parseInstall({ install: { env_command: ['uv', 3] } }),
    (err) => err instanceof InstallPlanError)
})

// --------------------------- 拒绝安装 ---------------------------

test('⛔⛔ 没钉 commit 就拒绝安装，不替用户拉最新版顶上', () => {
  const p = profileOf({
    upstream: {
      url: 'https://example.invalid/demo.git',
      commit: null,
      commit_unknown_reason: '上游 .git 当初被删了',
    },
  })
  assert.throws(() => buildInstallPlan(p, {}), (err) => {
    assert.equal(err.code, 'ENGINE_UPSTREAM_UNPINNED')
    // 报错要带上名片自己写的原因 —— 否则用的人只知道"不行"，不知道"为什么"。
    assert.match(err.message, /上游 \.git 当初被删了/)
    return true
  })
})

test('拒绝时说清了后果：拉最新版不会报错，只会声音不对', () => {
  const p = profileOf({ upstream: { url: 'https://example.invalid/d.git', commit: null } })
  assert.throws(() => buildInstallPlan(p, {}), /不会是报错/)
})

// ⭐ 「没写地址」和「没钉版本」是两个 code，故意不合并：
//    前者是名片漏填了，补上就行；
//    后者是那个号事后再也拿不回来（C10），补不了，只能人来定夺。
//    两种情况用的人要做的事完全不同，报同一个错等于把这个区别抹掉。
test('压根没有 upstream 就拒绝 —— 不知道从哪拉', () => {
  assert.throws(() => buildInstallPlan(profileOf({ upstream: null }), {}),
    (err) => err.code === 'ENGINE_UPSTREAM_MISSING')
})

test('有 commit 但没 url 也拒绝', () => {
  const p = profileOf({ upstream: { url: null, commit: SHA } })
  assert.throws(() => buildInstallPlan(p, {}),
    (err) => err.code === 'ENGINE_UPSTREAM_MISSING')
})
