// lib/engines/hostProfile.node.test.js
//
// ⭐⭐⭐ 这个文件在这一刀之前**不存在** —— buildHostProfile 一条测试都没有，
//   而它是「平台怎么调这台引擎」的最终装配点。
//
// 这里只钉一件事，但它是这一刀的地基：
//   **这一次选中的那一份模型，到底有没有真的到达引擎。**
//
// ⛔ 为什么单钉这一条：宿主填 init_args 里的 {checkpoints} 时不看启动命令行，
//   它是从这份 profile_json 的 runtime.checkpoints 自己取的。
//   ⇒ 只在启动计划的占位符表里顶替是不够的，而且**不会报错**：
//     进程照起、请求照收、声音是底模的。跟这一刀要修的那个 bug 一模一样。
//
// ⚠ 自检句：改「送什么给引擎」之前，先问这份数据**是谁读进去的**。

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { buildHostProfile } = require('./hostProfile')
const { listEngines } = require('./registry')

// ⛔ 不写死任何引擎 id：从注册表里挑一台真的声明了底模目录的。
//   一台都没有就跳过 —— 那是「盘上没有可测对象」，不是「测试失败」。
function pickEngineWithCheckpoints() {
  let ids = []
  try { ids = listEngines().map((e) => (typeof e === 'string' ? e : e.id)) } catch { return null }
  for (const id of ids) {
    try {
      const p = buildHostProfile(id)
      if (p && p.runtime && p.runtime.checkpoints) return { id, profile: p }
    } catch { /* 这台解析不出来是别的测试的事 */ }
  }
  return null
}

test('⭐⭐⭐ 选中的那一份模型必须落进 runtime.checkpoints（宿主只认这里）', (t) => {
  const found = pickEngineWithCheckpoints()
  if (!found) return t.skip('盘上没有声明了底模目录的引擎')

  const OVER = path.resolve('/tmp/aurivox-test-picked-model')
  const withOver = buildHostProfile(found.id, process.env, { checkpointsOverride: OVER })

  assert.equal(withOver.runtime.checkpoints, OVER,
    '顶替值没到 runtime.checkpoints ⇒ 宿主会照旧装底模，而且一声不吭')
  // 顶替的是**装哪一份模型**，不是「这台引擎变成了另一台」。
  assert.equal(withOver.id, found.profile.id)
  assert.deepEqual(withOver.call, found.profile.call)
})

test('⛔ 顶替不许污染没顶替的那一份（解析结果是共享的）', (t) => {
  const found = pickEngineWithCheckpoints()
  if (!found) return t.skip('盘上没有声明了底模目录的引擎')

  const before = found.profile.runtime.checkpoints
  buildHostProfile(found.id, process.env, { checkpointsOverride: '/tmp/x' })
  const after = buildHostProfile(found.id).runtime.checkpoints

  assert.equal(after, before,
    '顶替一次之后底模目录就回不去了 ⇒ 换过一次模型，之后每次启动都用那一份')
})

test('没顶替 / 顶替空值 ⇒ 一个字都不动', (t) => {
  const found = pickEngineWithCheckpoints()
  if (!found) return t.skip('盘上没有声明了底模目录的引擎')

  const base = found.profile.runtime.checkpoints
  assert.equal(buildHostProfile(found.id).runtime.checkpoints, base)
  assert.equal(buildHostProfile(found.id, process.env, {}).runtime.checkpoints, base)
  assert.equal(buildHostProfile(found.id, process.env, { checkpointsOverride: '' }).runtime.checkpoints, base)
  assert.equal(buildHostProfile(found.id, process.env, { checkpointsOverride: null }).runtime.checkpoints, base)
})

test('⭐⭐ 守卫：写 profile_json 的那个人必须把顶替值传下去', () => {
  // ⛔ 这条钉的是**接线**，不是行为：hostProfile 支持顶替、而 writeHostProfile
  //   不往下传的话，上面三条照样全绿，真机上却一份都传不到。
  //   （这正是这个项目栽过的那类坑：测试绕开了"数据怎么被读进来"那一步。）
  const src = require('node:fs').readFileSync(
    path.join(__dirname, 'engine-launch-plan.cjs'), 'utf8')
  const m = src.match(/writeHostProfileTo\(([^)]*)\)/)
  assert.ok(m, 'engine-launch-plan.cjs 里找不到 writeHostProfileTo 调用')
  assert.ok(/opts/.test(m[1]),
    'writeHostProfile 拿到的选项没有传给下一层 ⇒ 选中的模型到不了引擎')
})

test('⭐⭐⭐ 守卫：真正 spawn 的那个人必须把选中的模型写进 profile_json', () => {
  // ⛔ 这条钉的是这一刀最容易静默失效的一环。
  //   平台自己起引擎时，如果只 spawn 不写这份文件（或者写了但没带上顶替值），
  //   进程照起、请求照收、声音是底模的 —— 正是这一刀要修的那个 bug 原样复发。
  const src = require('node:fs').readFileSync(
    path.join(__dirname, 'spawnEngine.js'), 'utf8')
  assert.ok(/writeHostProfileTo\(/.test(src),
    'spawnEngine 没有写 profile_json ⇒ 宿主会读到上一次留在盘上的那份')
  assert.ok(/checkpointsOverride/.test(src),
    'spawnEngine 写了 profile_json 但没带上这一次选中的模型')
  // ⚠ 顺序：写文件必须在 spawn 之前。反了的话宿主开口就是「读不了解析结果」，
  //   而真正的原因（平台还没来得及写）已经看不见了。
  assert.ok(src.indexOf('writeHostProfileTo(') < src.indexOf('spawn(plan.python'),
    '先 spawn 后写文件 ⇒ 宿主读到的是上一次那份')
})
