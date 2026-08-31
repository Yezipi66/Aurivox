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
//
// ⭐⭐⭐ 刀 A1（2026-08-31）：这里过去写着「唯一的例外是 legacy_default 唯一性」。
//   那个不变量**已经不存在了** —— 连同 lib/engines/legacyDefault.js 一起删。
//   现在的不变量翻了个面：**任何一张名片都不许再写 legacy_default 这个键**。
//   ⭐ 为什么是"不许写"而不是"写了不读"：名片会被抄。留着一个平台不读的键，
//     第三台引擎的作者会连它一起抄走，然后花一天查为什么不生效。

const test = require('node:test')
const assert = require('node:assert')

const { listEngines } = require('./registry')
const { resolveEngineProfile } = require('./profile')

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
    // ⛔ 这里原本查 hot_swap_models 是不是 boolean —— 2026-08-30 那一位退休。
    //   换成查每个模型位自己的送法：这才是平台真正拿去做决定的东西。
    for (const s of profile.weight_slots || []) {
      assert.ok(s.applies_at === 'launch' || s.applies_at === 'call',
        `${manifest.id} 的模型位 ${s.name} 没说清换它要走哪一步（applies_at）`)
    }
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

// ⭐⭐⭐ 刀 A1 归零守卫（翻面自「有且只有一张真名片认领老路径引擎」）。
test('⭐⭐⭐ 刀 A1: 没有任何一张真名片再写 legacy_default', () => {
  const offenders = engines
    .filter((m) => Object.prototype.hasOwnProperty.call(m, 'legacy_default'))
    .map((m) => m.id)
  assert.deepEqual(offenders, [],
    `这些名片还写着 legacy_default：${offenders.join(', ')}。\n` +
    '平台已经不读它了。留着 = 下一个作者会抄走它，然后查一天为什么不生效。')
})

test('⭐⭐ 刀 A1: engines/ 下的名片文件里一个 legacy_default 字样都搜不到（含注释键）', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { ENGINES_DIR } = require('../paths')   // ⚠ 不在 registry 里，在 paths 里
  const hits = []
  for (const m of engines) {
    const f = path.join(ENGINES_DIR, m.id, 'manifest.json')
    if (!fs.existsSync(f)) continue
    const src = fs.readFileSync(f, 'utf-8')
    // ⭐ 盯的是**键**，不是字样：`"legacy_default":`。
    //   ⛔ 不能盯字样 —— 我们特意在名片里留了一段墓碑注释
    //   （`_comment_legacy_default_removed`，写明这里过去有什么、为什么删），
    //   那段散文里必然出现这个词，而散文不会被人当成配置抄走，键才会。
    //   ⚠ `_comment_*` 本身也是键，所以下面先把 `_comment` 开头的键排除。
    for (const line of src.split('\n')) {
      const key = /^\s*"([^"]+)"\s*:/.exec(line)
      if (!key) continue
      if (key[1].startsWith('_comment')) continue
      if (key[1] !== 'legacy_default') continue
      hits.push(`${m.id}: ${line.trim()}`)
    }
  }
  assert.deepEqual(hits, [], `名片里还留着 legacy_default：\n${hits.join('\n')}`)
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

// ---------------------------------------------------------------------------
//  upstream —— 契约 C10：唯一必须留在 git 里的上游信息，就是那个 commit 号
// ---------------------------------------------------------------------------
// 这里盯的是**我们自己这两台**，比 profile.js 的解析规则严：
// 解析规则对第三方引擎宽容（缺档案不该让一台正在出声的引擎合成不了），
// 但我们自己的名片漏了，就等于永久丢失 —— 上游 .git 一删，事后补不回来。
for (const manifest of engines) {
  test(`真名片体检：${manifest.id} 的 upstream 记全了（C10：commit 号不可再生）`, () => {
    const up = manifest.upstream
    assert.ok(up && typeof up === 'object' && !Array.isArray(up),
      `${manifest.id} 的 upstream 得是对象（url/commit/license），` +
      `光写一个网址回答不了「装哪一版」`)

    assert.equal(typeof up.url, 'string', `${manifest.id} 缺 upstream.url`)
    assert.match(up.url, /^https?:\/\//, `${manifest.id} 的 upstream.url 要带协议头`)

    assert.ok('commit' in up,
      `${manifest.id} 连 commit 这个键都没有。写 null 也行，但要写出来 —— ` +
      `键不在，读的人分不清「没记」还是「忘了填」`)

    if (up.commit === null) {
      // 留空是合法的（C13.1），但必须说清为什么 —— 这是 C13.2 的同一个道理：
      // 填了要说出处，那么留空就要说原因。否则下一个人只能猜。
      assert.equal(typeof up.commit_unknown_reason, 'string',
        `${manifest.id} 的 commit 是 null 却没写 commit_unknown_reason`)
      assert.ok(up.commit_unknown_reason.length >= 10,
        `${manifest.id} 的 commit_unknown_reason 太短了，看不出发生过什么`)
    } else {
      assert.match(up.commit, /^[0-9a-f]{40}$/,
        `${manifest.id} 的 upstream.commit 要么是完整 40 位小写 sha，要么是 null`)
    }
  })
}

test('真名片体检：install.env_command 写了就得是非空字符串数组', () => {
  for (const manifest of engines) {
    if (!manifest.install) continue
    const cmd = manifest.install.env_command
    if (cmd === undefined) continue
    assert.ok(Array.isArray(cmd) && cmd.length > 0,
      `${manifest.id} 的 install.env_command 得是非空数组`)
    assert.ok(cmd.every((x) => typeof x === 'string' && x.length > 0),
      `${manifest.id} 的 install.env_command 里有非字符串`)
  }
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

// ---------------------------------------------------------------------------
//  起多台引擎要靠的三条不变量（2026-08-29）
// ---------------------------------------------------------------------------
// 这三条以前不需要成立，因为平台一次只起一台。start.ps1 改成能同时起多台
// 之后，任何一条破了都会变成「两台一起起时，其中一台莫名其妙不工作」——
// 而两张 manifest.json 各自单看都没毛病。所以判据只能建在**全体**上。

test('⭐⭐ 每台由平台启动的引擎都要写 base_url_env', () => {
  // 端口被别的程序占了，平台会把这台引擎挪到下一个空位。挪完之后后端得
  // 知道新地址，唯一的渠道就是这个环境变量。没写这一行，端口一挪，后端
  // 仍然去连老地址 —— 引擎明明起来了，发给它的合成全部失败，而且日志里
  // 看不出为什么，因为引擎自己一切正常。
  const { buildLaunchPlan } = require('./launchPlan')
  const path = require('node:path')
  const ROOT = path.resolve(__dirname, '..', '..')
  const missing = []
  for (const manifest of engines) {
    const profile = resolveEngineProfile(manifest.id, process.env)
    if (!buildLaunchPlan(profile, { rootDir: ROOT }).launchable) continue
    if (!profile.base_url_env) missing.push(manifest.id)
  }
  assert.deepEqual(missing, [],
    `这些引擎的 manifest.json 缺 base_url_env：${missing.join(', ')}\n` +
    '在 engines/<id>/manifest.json 里加一行，例："base_url_env": "XXX_BASE_URL"')
})

test('⛔ 两台引擎不许共用同一个 base_url_env', () => {
  // 共用了，启动脚本会先把 A 的地址写进去，再被 B 覆盖掉 ——
  // 后端于是把两台引擎的请求全发给 B。
  const seen = new Map()
  for (const manifest of engines) {
    const key = resolveEngineProfile(manifest.id, process.env).base_url_env
    if (!key) continue
    assert.ok(!seen.has(key),
      `${manifest.id} 和 ${seen.get(key)} 都用 ${key} 报地址`)
    seen.set(key, manifest.id)
  }
})

// ---------------------------------------------------------------------------
//  底模（2026-08-29）
// ---------------------------------------------------------------------------
// ⛔ 这里**不判「底模在不在盘上」**。跑测试的机器上有没有下过几个 GB 的权重，
//   跟名片写得对不对是两回事；那样的测试会在 CI 上永远红、在开发机上永远绿。
//   判的是「这张名片说得出底模在哪」，以及「说出来的话平台读得下去」。

test('⭐ 每一张真名片都要说得出底模在哪（runtime.checkpoints）', () => {
  // 这条判据的来历是 Owner 那句「你都读不到底模在哪里」：在它之前，有一台
  // 引擎的底模目录是**写死在平台代码里**的，名片上一个字都没有 ⇒ 界面无从显示。
  // 现在两台都写在名片上，口径统一。⛔ 别为了让新引擎好过而放宽这条：
  //   不写的代价不是"少一个字段"，是这台引擎的底模在界面上永远是一片空白。
  for (const manifest of engines) {
    const p = resolveEngineProfile(manifest.id, process.env)
    if (!p.runtime) continue // 不由平台启动的引擎不在此列
    assert.ok(p.runtime.checkpoints,
      `${manifest.id} 的名片没写 runtime.checkpoints —— ` +
      '平台不知道它的底模在哪，也就没法告诉接入的人该往哪儿放')
  }
})

test('⭐ 每一张真名片的底模状态都算得出来（三态之一，不抛）', () => {
  const { checkpointStatus, describeCheckpointStatus } = require('./checkpoints')
  for (const manifest of engines) {
    const p = resolveEngineProfile(manifest.id, process.env)
    const st = checkpointStatus(p)
    assert.ok(st.ready === true || st.ready === false || st.ready === null,
      `${manifest.id} 的 ready 不是三态之一：${JSON.stringify(st.ready)}`)
    // 说得出位置的，就必须给绝对路径 —— 人要去放文件，相对路径没用。
    if (st.declared) assert.ok(require('node:path').isAbsolute(st.abs_path))
    // 一句人话在任何一态下都得说得出来（界面的 title 直接用它）。
    assert.ok(describeCheckpointStatus(st).trim())
  }
})

test('⛔⛔ 两台引擎的 own_process_mark 不许一样', () => {
  // 这是启动脚本认「这个端口上蹲着的是不是我自家引擎」的唯一凭据。
  // 两台记号相同时：B 恰好占着 A 想要的端口 ⇒ 脚本判成「A 已经在跑了」
  // ⇒ 跳过启动 A ⇒ A 永远起不来，而且**不报错**。
  const { buildLaunchPlan } = require('./launchPlan')
  const path = require('node:path')
  const ROOT = path.resolve(__dirname, '..', '..')
  const seen = new Map()
  for (const manifest of engines) {
    const plan = buildLaunchPlan(resolveEngineProfile(manifest.id, process.env), { rootDir: ROOT })
    if (!plan.launchable) continue
    const mark = plan.own_process_mark
    assert.ok(mark, `${manifest.id} 没有 own_process_mark`)
    assert.ok(!seen.has(mark),
      `${manifest.id} 和 ${seen.get(mark)} 的记号都是 ${mark}`)
    seen.set(mark, manifest.id)
  }
})

test('⛔⛔ 每一张真名片都要能过 buildHostProfile —— 过不了这台引擎会被整台跳过', () => {
  // 2026-08-30 真机事故，我自己造的：我在 manifest 的 `call` 里加了一个
  // `_comment_init_args` 说明键。它读起来无害，运行时是这样的：
  //
  //   lib/engines/hostProfile.js:57 CALL_KEYS 是**封闭白名单**
  //     （kind/module/class/init_args/method/bind/returns/seed/cwd）
  //   ⇒ 多一个键 = ENGINE_HOST_CONTRACT_INVALID
  //   ⇒ 启动脚本「算不出 indextts2 的启动计划，跳过这一台」
  //   ⇒ 这台引擎压根没起，前端拿到的是 "Internal server error"。
  //
  // ⭐ 为什么原来那条 resolveEngineProfile 的体检挡不住：它读的是名片的
  //    另一半（地址、超时、底模位），`call` 那一段它根本不看。
  //    ⇒ 「名片解析得出来」和「宿主能照它调引擎」是两道门，要各测各的。
  //
  // ⛔ 顺带钉死另一个更早的坑：init_args 里也不许有 _ 开头的键 ——
  //    host.py:360 是 klass(**init_args)，整个 dict 原样进构造函数。
  //    这一条 buildHostProfile 查不出来（它只管键名合法），所以单独断言。
  const { buildHostProfile } = require('./hostProfile')
  for (const manifest of engines) {
    if (!manifest.call) continue      // 不走通用宿主的引擎（如 GSV）没有这一段
    let host
    try {
      host = buildHostProfile(manifest.id, process.env)
    } catch (err) {
      // 原样呈出来 —— 这类错误自己就写着「哪个键不认得、认得的有哪些」。
      assert.fail(`${manifest.id} 的 call 段过不了宿主契约：\n${err.message}`)
    }
    const bad = Object.keys(host.call.init_args || {}).filter((k) => k.startsWith('_'))
    assert.deepEqual(bad, [],
      `${manifest.id} 的 call.init_args 里有 ${bad.join(', ')}；` +
      `它会原样进 klass(**init_args)。注释写到 manifest 顶层的 _comment_* 里去`)
  }
})
