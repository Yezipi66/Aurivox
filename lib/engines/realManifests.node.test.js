'use strict'

// ---------------------------------------------------------------------------
//  真名片体检 —— 仓库里 engines/* 的名片必须真的能被解析
// ---------------------------------------------------------------------------
// profile.node.test.js 用的是临时目录里造的假名片，测的是**解析规则**。
// 本文件测的是**仓库现状**：engines/ 下每一张真名片，今天能不能读出来。
//
// 分成两个文件是有意的：
//   规则测试不该因为业务调了个 max_chars 就红；
//   现状测试不该锁死具体数值，否则同一件事要改两处。
// 所以下面**只判「读得出来、字段齐、类型对」，绝不断言具体数值**。
// 唯一的例外是 legacy_default 唯一性 —— 那不是数值，是不变量。

const test = require('node:test')
const assert = require('node:assert')

const { listEngines } = require('./registry')
const { resolveEngineProfile } = require('./profile')
const { findLegacyDefaultId } = require('./legacyDefault')

const engines = listEngines()

test('engines/ 下至少装了一台引擎（否则这个仓库合成不了任何东西）', () => {
  assert.ok(engines.length > 0, `一台都没找到；检查 ENGINES_DIR 是否正确`)
})

for (const manifest of engines) {
  test(`真名片体检：${manifest.id} 能被解析成引擎档案`, () => {
    let profile
    try {
      profile = resolveEngineProfile(manifest.id, process.env)
    } catch (err) {
      // 把名片校验的错误原样呈出来 —— 这类错误本身就写着「缺哪一行、去哪补」，
      // 包装成「测试失败」反而丢信息。
      assert.fail(`${manifest.id} 的名片读不出来：\n${err.message}`)
    }
    assert.equal(typeof profile.base_url, 'string')
    assert.match(profile.base_url, /^https?:\/\//, '地址要带协议头')
    assert.ok(Number.isInteger(profile.timeout_ms) && profile.timeout_ms > 0)
    assert.ok(Number.isInteger(profile.max_chars) && profile.max_chars > 0)
    assert.equal(profile.hard_max_chars, profile.max_chars * 2)
    assert.equal(typeof profile.hot_swap_models, 'boolean')
    assert.equal(typeof profile.requires_reference_audio, 'boolean')
    assert.equal(typeof profile.supports_finetune, 'boolean')
    assert.ok(Number.isInteger(profile.output_sample_rate) && profile.output_sample_rate > 0)
  })

  // ⭐⭐ 第 1c 步加的体检。profile.js 把 maps / payload_keys / defaults 缺省成空，
  //   是为了让只关心地址和超时的调用方（换权重、健康检查）不必写全 —— 但对
  //   **真名片**来说，"空"就是静默回落：拼出来的请求体会少键，引擎那边表现成
  //   一句模糊的上游报错，或者更糟，静默用错默认值。所以现状测试盯死这一条。
  test(`真名片体检：${manifest.id} 写全了 maps（否则请求体会静默少键）`, () => {
    const profile = resolveEngineProfile(manifest.id, process.env)
    assert.equal(typeof profile.maps, 'object')
    assert.ok(profile.maps && !Array.isArray(profile.maps))
    assert.ok(profile.maps.text,
      `${manifest.id} 的名片没说「要合成的文本」在这台引擎那里叫什么键名（maps.text）—— ` +
      '缺了它连请求体的第一个键都拼不出来')
    // 映射的值必须是非空字符串。写 null / 不写 = 这台引擎没这个概念（合法）；
    // 映射到空串 = 说了等于没说，那是名片写坏了。
    for (const [k, v] of Object.entries(profile.maps)) {
      assert.equal(typeof v, 'string', `maps.${k} 必须是字符串（引擎的键名）`)
      assert.ok(v.length > 0, `maps.${k} 映射到了空串 —— 没有这个概念就整行不写，别写空`)
    }
    // 参考音频：名片说"必须有参考音频"，就必须同时说清楚它叫什么键名，
    // 否则平台会拦下没有参考音频的请求，却又发不出参考音频 —— 自相矛盾。
    if (profile.requires_reference_audio) {
      assert.ok(profile.maps.reference_audio,
        `${manifest.id} 声明 requires_reference_audio=true，却没有 maps.reference_audio`)
    }
  })

  test(`真名片体检：${manifest.id} 的 payload_keys / defaults 类型正确且不互相矛盾`, () => {
    const profile = resolveEngineProfile(manifest.id, process.env)
    assert.ok(Array.isArray(profile.payload_keys), 'payload_keys 必须是数组')
    for (const k of profile.payload_keys) {
      assert.equal(typeof k, 'string')
      assert.ok(k.length > 0)
    }
    assert.strictEqual(new Set(profile.payload_keys).size, profile.payload_keys.length,
      `${manifest.id} 的 payload_keys 里有重复项`)
    assert.ok(profile.defaults && typeof profile.defaults === 'object' && !Array.isArray(profile.defaults))
    // 默认值的键必须是这台引擎收得下的键 —— 否则平台会自动往请求体里塞一个
    // 引擎不认识的东西，而且每一次调用都塞。
    const mapped = new Set(Object.values(profile.maps))
    for (const k of Object.keys(profile.defaults)) {
      assert.ok(profile.payload_keys.includes(k) || mapped.has(k),
        `${manifest.id} 的 defaults.${k} 既不在 payload_keys 上，也不是任何一个平台词的映射目标 —— ` +
        '这个默认值会被无条件塞进每一次请求，引擎多半不认识它')
    }
  })

  test(`真名片体检：${manifest.id} 声明了 contract_version 2`, () => {
    assert.equal(manifest.contract_version, 2,
      `${manifest.id} 的名片没写 contract_version:2 —— ` +
      '契约版本是给将来做兼容判断用的，缺了以后没法区分老名片和新名片')
  })
}

test('⭐ 有且只有一张真名片认领「老路径引擎」这个身份', () => {
  const id = findLegacyDefaultId(engines)
  assert.ok(engines.some((m) => m.id === id))
})

// ---------------------------------------------------------------------------
//  runtime 体检
// ---------------------------------------------------------------------------
// ⭐ 这里只判「路径写得对不对」，不判「东西在不在」—— 环境装没装是这台机器
//   的状态，不是仓库的状态，CI 上没有任何引擎的 venv。装没装用
//   `node tools/dev/check-engine-env.cjs` 去问，那是人的工具，不是测试。

for (const manifest of engines) {
  test(`真名片体检：${manifest.id} 的 runtime 段（有就得写对）`, () => {
    const rt = resolveEngineProfile(manifest.id, process.env).runtime
    if (!rt) return   // 不由平台起，合法
    for (const [key, value] of [['python', rt.python], ['entry', rt.entry]]) {
      assert.equal(typeof value, 'string')
      assert.ok(value.length > 0, `${manifest.id} 的 runtime.${key} 是空的`)
      assert.ok(!/^([A-Za-z]:[\\/]|[\\/])/.test(value),
        `${manifest.id} 的 runtime.${key} 是绝对路径 —— 名片要能跟着项目搬家`)
      // ⛔ 反斜杠会在非 Windows 上被当成路径的一部分而不是分隔符。
      assert.ok(!value.includes('\\'),
        `${manifest.id} 的 runtime.${key} 里有反斜杠，名片里的路径一律用正斜杠`)
    }
    assert.ok(rt.ready_endpoint.startsWith('/'))
    assert.ok(Number.isInteger(rt.ready_timeout_ms) && rt.ready_timeout_ms > 0)
  })
}

test('⭐ 仓库里的每一张真名片都要写 runtime + verify', () => {
  // runtime 缺失在解析层面是合法的（别人的引擎可以自己起自己），但**这个仓库
  // 里**的引擎不行：进程怎么起一旦不写在名片上，就只能写在平台的启动脚本里，
  // 那正是契约 §9 记的那笔账。这条守卫是不让账再涨的闸。
  for (const manifest of engines) {
    const rt = resolveEngineProfile(manifest.id, process.env).runtime
    assert.ok(rt, `${manifest.id} 的名片没有 runtime 段 —— ` +
      '这台引擎怎么起就只能写死在平台的启动脚本里，那是契约 §9 那笔账的来源')
    assert.ok(rt.verify, `${manifest.id} 写了 runtime 却没写 runtime.verify —— ` +
      '平台能起它却没法在起之前判断它装没装，用户拿到的会是一句超时')
    assert.ok(rt.verify.imports.length > 0)
  }
})

test('⭐ ready_endpoint 必须在入口脚本里真的存在（防照着别的名片抄）', () => {
  // GSV 的探活地址是 "/"（infer_server.py 的 @APP.get("/")，函数名就叫
  // health），IndexTTS2 的是 "/health"。照着后者把前者抄成 /health，名片看着
  // 完全正常，表现是轮询到超时为止 —— 一个要等三分钟才现形的错。
  const fs = require('node:fs')
  const path = require('node:path')
  const ROOT = path.resolve(__dirname, '..', '..')

  let checked = 0
  for (const manifest of engines) {
    const rt = resolveEngineProfile(manifest.id, process.env).runtime
    if (!rt) continue
    const entry = path.resolve(manifest.dir, rt.entry)
    // 入口不在仓库里（引擎源码没进仓库）就查不了，跳过而不是假装查过。
    if (!fs.existsSync(entry)) continue
    const src = fs.readFileSync(entry, 'utf8')
    const quoted = [`"${rt.ready_endpoint}"`, `'${rt.ready_endpoint}'`]
    assert.ok(quoted.some((q) => src.includes(q)),
      `${manifest.id} 的 ready_endpoint = ${rt.ready_endpoint}，` +
      `但 ${path.relative(ROOT, entry)} 里根本没有这个地址`)
    // ⭐ 守卫自验：一个编出来的地址必须查不到，否则这条断言没有判别力。
    assert.ok(!src.includes('"/aurivox-no-such-endpoint"'),
      '这条守卫失去了判别力（连编造的地址都能"查到"）')
    checked += 1
  }
  assert.ok(checked > 0, '一台都没查到 —— 这条守卫现在是摆设')
})

test('⭐ 每一张真名片都要能算出一份启动计划（args / cwd 体检）', () => {
  // 为什么这条要放在**这里**而不是只放在 launchPlan.node.test.js：
  // 那边的真名片断言是逐字对着 gpt-sovits / indextts2 写死的 —— 它守的是
  // 「这两台今天怎么起」。明天有人加第三张名片时，那些断言一条都不会亮。
  // 这条守的是另一件事：**engines/ 下的每一张名片**，不管今天有几张。
  const { buildLaunchPlan } = require('./launchPlan')
  const path = require('node:path')
  const ROOT = path.resolve(__dirname, '..', '..')

  let checked = 0
  for (const manifest of engines) {
    const profile = resolveEngineProfile(manifest.id, process.env)
    if (!profile.runtime) continue

    let plan
    try {
      plan = buildLaunchPlan(profile, { rootDir: ROOT })
    } catch (err) {
      assert.fail(`${manifest.id} 的名片算不出启动计划：${err.message}\n` +
        '这张名片装上去以后，平台起这台引擎时才会炸，而那时报错出现在启动窗口里。')
    }

    assert.equal(plan.launchable, true, `${manifest.id} 写了 runtime 却不可启动`)
    assert.ok(Array.isArray(plan.args), `${manifest.id} 的 args 不是数组`)
    for (const a of plan.args) {
      assert.equal(typeof a, 'string', `${manifest.id} 的 args 里有非字符串项`)
      // 展开完还剩花括号 = 有占位符没被处理掉，会原样出现在命令行上。
      assert.ok(!/[{}]/.test(a),
        `${manifest.id} 的 args 展开后仍有花括号：${a} —— 这一串会原样传给引擎`)
    }

    // cwd 必须落在项目根之内。名片是外来数据，cwd 是直接交给
    // Start-Process -WorkingDirectory 的，一个 "../.." 就把工作目录挪出了安装目录，
    // 而引擎里所有相对路径（权重、配置、日志）都是相对它算的。
    const cwd = path.resolve(plan.cwd)
    assert.ok(cwd === ROOT || cwd.startsWith(ROOT + path.sep),
      `${manifest.id} 的 runtime.cwd 指到了项目根外面：${cwd}`)

    // 端口要能被 start.ps1 的解冲突那一步覆盖掉，所以名片端口和实际端口
    // 必须是两个字段而不是同一个。
    assert.ok(Number.isInteger(plan.desired_port) && plan.desired_port > 0,
      `${manifest.id} 没给出名片端口`)
    checked += 1
  }
  assert.ok(checked > 0, '一台都没查到 —— 这条守卫现在是摆设')
})

test('两台引擎不许监听同一个地址（否则合成会连错台且毫无提示）', () => {
  const seen = new Map()
  for (const m of engines) {
    const url = resolveEngineProfile(m.id, process.env).base_url
    if (seen.has(url)) {
      assert.fail(`引擎 ${seen.get(url)} 和 ${m.id} 的地址都是 ${url} —— ` +
        '两个进程不可能同时监听同一个端口，其中一台必然连错')
    }
    seen.set(url, m.id)
  }
})
