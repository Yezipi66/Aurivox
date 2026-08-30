'use strict'

// ---------------------------------------------------------------------------
//  lib/engines/launchPlan.js 的测试
// ---------------------------------------------------------------------------
// 这组测试盯着两件事：
//
//  1. 对 GPT-SoVITS，算出来的计划必须和搬家前 start.ps1 写死的那一套
//     **逐字相同** —— 那是第 2c 步全部的验收标准（「行为一个字节不变」）。
//     见下面的「黄金样本」一节：它是从 start.ps1 的四行代码抄下来的，
//     不是从我的实现反推的。
//
//  2. 名片写错时必须**当场抛**，不能把一个字面量占位符传给引擎。
//     ⛔ 这条比第 1 条更容易写成摆设：一个 `{prot}` 原样传下去，表现是
//     「引擎说某文件找不到」，查半天才发现是名片拼错了。

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')

const { buildLaunchPlan, PLACEHOLDERS } = require('./launchPlan')

const ROOT = path.resolve(__dirname, '..', '..')

// --- 夹具 ------------------------------------------------------------------
// ⚠ 不从盘上读真名片来做这些用例 —— 真名片会变，变了这组测试就在测「今天
//   名片长什么样」而不是「算法对不对」。真名片另有一组体检（见文件末尾）。
function fakeProfile(over = {}) {
  const runtime = Object.assign({
    python: 'venv/Scripts/python.exe',
    entry: 'run.py',
    args: [],
    cwd: null,
    checkpoints: null,
    ready_endpoint: '/',
    ready_timeout_ms: 1000,
    preload: false,
    verify: null,
  }, over.runtime || {})
  return Object.assign({
    id: 'fake',
    label: 'Fake',
    dir: path.join(ROOT, 'engines', 'fake'),
    default_base_url: 'http://127.0.0.1:9999',
    base_url: 'http://127.0.0.1:9999',
    base_url_source: 'manifest',
  }, over, { runtime })
}

// ===========================================================================
//  一、路径解析
// ===========================================================================

test('launchPlan: python 相对项目根，entry 相对名片所在目录', () => {
  const plan = buildLaunchPlan(fakeProfile(), { rootDir: ROOT })
  assert.equal(plan.python, path.resolve(ROOT, 'venv/Scripts/python.exe'))
  assert.equal(plan.entry, path.resolve(ROOT, 'engines', 'fake', 'run.py'))
})

test('launchPlan: entry 的 ../../ 能走出引擎目录（GPT-SoVITS 今天就是这样）', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { entry: '../../lib/inference/infer_server.py' } }),
    { rootDir: ROOT })
  assert.equal(plan.entry, path.resolve(ROOT, 'lib/inference/infer_server.py'))
})

test('launchPlan: 没写 cwd 时落在项目根，不是引擎目录', () => {
  // ⛔ 这条不是口味问题：infer_server.py 里有相对 CWD 的路径，
  //   落到 engines/gpt-sovits/ 会让它找不到东西。
  const plan = buildLaunchPlan(fakeProfile(), { rootDir: ROOT })
  assert.equal(plan.cwd, ROOT)
})

test('launchPlan: 写了 cwd 就按写的来（相对项目根）', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { cwd: 'engines/fake' } }), { rootDir: ROOT })
  assert.equal(plan.cwd, path.resolve(ROOT, 'engines/fake'))
})

// ===========================================================================
//  二、端口：「听哪儿」只能来自名片
// ===========================================================================

test('launchPlan: 不传 port 时用名片声明的那个', () => {
  const plan = buildLaunchPlan(fakeProfile(), { rootDir: ROOT })
  assert.equal(plan.port, 9999)
  assert.equal(plan.desired_port, 9999)
})

test('launchPlan: 传了 port 就用传进来的，desired_port 仍是名片那个', () => {
  // ⭐ 两个数必须分得清：调用方要能说出「本来想用 9880，被占了，挪到 9881」。
  const plan = buildLaunchPlan(fakeProfile(), { rootDir: ROOT, port: 10001 })
  assert.equal(plan.port, 10001)
  assert.equal(plan.desired_port, 9999)
  assert.equal(plan.base_url, 'http://127.0.0.1:10001')
  assert.equal(plan.ready_url, 'http://127.0.0.1:10001/')
})

test('⛔ launchPlan: 监听端口绝不读 base_url_env 顶出来的地址', () => {
  // 这是本文件里最要紧的一条。有人把 GPT_SOVITS_BASE_URL 指到别的机器上时，
  // 「连哪儿」变了，「听哪儿」不能跟着变 —— 否则会在本地起出一台监听
  // 远程端口号的引擎。profile 里两个字段并存就是为了这件事。
  const plan = buildLaunchPlan(fakeProfile({
    base_url: 'http://10.0.0.7:7777',          // env 顶出来的：连这儿
    base_url_source: 'env:FAKE_BASE_URL',
    default_base_url: 'http://127.0.0.1:9999', // 名片声明的：听这儿
  }), { rootDir: ROOT })
  assert.equal(plan.port, 9999)
  assert.equal(plan.host, '127.0.0.1')
  assert.ok(!JSON.stringify(plan).includes('10.0.0.7'),
    '计划里不该出现任何 env 顶出来的地址')
})

test('launchPlan: default_base_url 没端口要抛（没端口就没法起进程）', () => {
  assert.throws(
    () => buildLaunchPlan(fakeProfile({ default_base_url: 'http://127.0.0.1' }), { rootDir: ROOT }),
    /必须是带端口的地址/)
})

// assert.throws 不把异常还给你（它只判真假）。要看错误正文就得自己接住 ——
// ⚠ 别用 `const e = assert.throws(...)`，那永远是 undefined，写出来的断言
//   会静默变成对 undefined 取属性，测试红得莫名其妙。
function grab(fn) {
  try { fn() } catch (e) { return e }
  assert.fail('本该抛，却没抛')
}

test('launchPlan: 缺 default_base_url 要抛，且错误里要说清听/连的区别', () => {
  const err = grab(() => buildLaunchPlan(fakeProfile({ default_base_url: null }), { rootDir: ROOT }))
  assert.ok(/default_base_url/.test(err.message), err.message)
  assert.ok(/听哪儿/.test(err.message) && /连哪儿/.test(err.message), err.message)
})

test('launchPlan: 非法端口要抛', () => {
  for (const bad of [0, 70000, -1, 1.5, 'abc']) {
    assert.throws(() => buildLaunchPlan(fakeProfile(), { rootDir: ROOT, port: bad }),
      /不是一个合法端口号/, `端口 ${bad} 应该被拦下`)
  }
})

// ===========================================================================
//  三、args 占位符
// ===========================================================================

test('launchPlan: {host} / {port} 被填成实际值', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['-a', '{host}', '-p', '{port}'] } }),
    { rootDir: ROOT, port: 12345 })
  assert.deepEqual(plan.args, ['-a', '127.0.0.1', '-p', '12345'])
})

test('launchPlan: {port} 展开成字符串（命令行参数不能是数字）', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['{port}'] } }), { rootDir: ROOT })
  assert.strictEqual(plan.args[0], '9999')
  assert.equal(typeof plan.args[0], 'string')
})

test('launchPlan: 路径占位符展开后要规整（.. 必须被折掉）', () => {
  // ⚠ 这条测的是 expandArg 末尾那次 path.normalize。
  //   本来只写了「混合分隔符要被规整」，但那个后果**只在 Windows 上看得见**
  //   —— 在这台 Linux 上把 normalize 整个删掉，那条断言照样绿（突变验证
  //   当场抓到了）。normalize 还有一个跨平台可见的后果：折 ".."。
  //   ⭐ 通则：守卫的后果如果只在验不了的平台上出现，就换一个在这里
  //     看得见的后果去钉它，别把摆设留在那儿充数。
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['{engine_dir}/../../lib/x.yaml'] } }),
    { rootDir: ROOT })
  assert.equal(plan.args[0], path.join(ROOT, 'lib', 'x.yaml'))
  assert.ok(!plan.args[0].includes('..'), '展开后不该还留着 ..')
})

test('launchPlan: {root} / {engine_dir} 展开后按本机分隔符规整', () => {
  // 名片里写 / （契约要求，反斜杠在非 Windows 上会被当成文件名的一部分），
  // 展开后必须变成本机的样子，否则和 Join-Path 拼出来的不是同一个字符串。
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['{root}/lib/x.yaml', '{engine_dir}/y.yaml'] } }),
    { rootDir: ROOT })
  assert.equal(plan.args[0], path.join(ROOT, 'lib', 'x.yaml'))
  assert.equal(plan.args[1], path.join(ROOT, 'engines', 'fake', 'y.yaml'))
  assert.ok(!plan.args[0].includes('/' + path.sep) && !plan.args[0].includes(path.sep + '/'),
    '不该留下混合分隔符')
})

test('launchPlan: {checkpoints} 展开成绝对权重目录', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['--ckpt', '{checkpoints}'], checkpoints: 'models/x/ckpt' } }),
    { rootDir: ROOT })
  assert.equal(plan.args[1], path.resolve(ROOT, 'models/x/ckpt'))
})

test('⛔ launchPlan: 用了 {checkpoints} 却没写 runtime.checkpoints 要抛', () => {
  // 不抛的话，引擎进程（今天是 lib/engines/host.py）会收到字面量
  // "{checkpoints}" 并报「目录不存在」——
  // 那句话会把人引到「权重没下」，而真相是名片少写一行。
  assert.throws(
    () => buildLaunchPlan(
      fakeProfile({ runtime: { args: ['--ckpt', '{checkpoints}'] } }), { rootDir: ROOT }),
    /必须写 runtime\.checkpoints|没有给出它的值/)
})

test('⛔ launchPlan: 不认识的占位符要抛，不能原样传下去', () => {
  const err = grab(() => buildLaunchPlan(
    fakeProfile({ runtime: { args: ['-p', '{prot}'] } }), { rootDir: ROOT }))
  assert.ok(/不认识的占位符/.test(err.message), err.message)
  assert.ok(err.message.includes('{prot}'), '错误里要指出是哪个占位符')
  // 认识的那几个要在错误里列出来 —— 拼错的人需要的正是这张表。
  for (const p of PLACEHOLDERS) assert.ok(err.message.includes(`{${p}}`))
})

test('launchPlan: 一个参数里可以有多个占位符', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['--addr={host}:{port}'] } }),
    { rootDir: ROOT, port: 8080 })
  assert.equal(plan.args[0], '--addr=127.0.0.1:8080')
})

test('launchPlan: 没有占位符的参数原样保留', () => {
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['--verbose', '-x', '1'] } }), { rootDir: ROOT })
  assert.deepEqual(plan.args, ['--verbose', '-x', '1'])
})

// ===========================================================================
//  四、认自家进程的记号
// ===========================================================================

test('launchPlan: own_process_mark 是入口的绝对路径且全小写', () => {
  // ⚠ 夹具的入口故意带大写（Run.PY）：本项目在这台机器上的路径全是小写，
  //   用小写入口做夹具的话，把 .toLowerCase() 删掉这条也照样绿 ——
  //   突变验证抓到过。要钉住转小写，就得给它一个真的有大写的输入。
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { entry: 'Run.PY' } }), { rootDir: ROOT })
  assert.equal(plan.own_process_mark, path.resolve(ROOT, 'engines/fake/Run.PY').toLowerCase())
  assert.ok(!/[A-Z]/.test(plan.own_process_mark),
    '调用方 Test-IsOwnProcess 的命令行已经 ToLowerInvariant 过，带大写的记号永远命中不了')
})

test('⛔ launchPlan: 两台引擎的入口同名时，记号必须仍然分得开', () => {
  // ⚠ 这条的原话是「_TEMPLATE 里入口就叫 shim.py，所以同名不是假想」。
  //   2026-08-27 那个前提没了：shim.py 已删，模板的入口改成了通用宿主。
  //   但**这条测试本身没有过期** —— 不由宿主托管、自带服务端的引擎（今天是
  //   gpt-sovits）仍然写自己的入口文件，重名照样可能发生。下面用 serve.py
  //   做夹具，就是为了把「同名」这件事和某个具体历史文件解绑。
  // 记号要是只取文件名，start.ps1 会把 B 引擎的进程认成 A 的，于是 A
  // 永远起不来且不报错。
  // ⭐ 走宿主的那一路更狠：不是「可能同名」而是「必然同路径」，由下一条盯着。
  const a = buildLaunchPlan(fakeProfile({
    id: 'a', dir: path.join(ROOT, 'engines', 'a'), runtime: { entry: 'serve.py' },
  }), { rootDir: ROOT })
  const b = buildLaunchPlan(fakeProfile({
    id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: { entry: 'serve.py' },
  }), { rootDir: ROOT })
  assert.notEqual(a.own_process_mark, b.own_process_mark)
})

test('⛔⛔ launchPlan: 两台引擎都走通用宿主时，记号必须仍然分得开', () => {
  // ⭐⭐ 上面那条防的是「入口**可能**同名」，靠的是入口绝对路径带上了各自的
  //   engines/<id>/ 目录。通用宿主把这条保护抽掉了：走 host.py 的引擎，
  //   入口的**绝对路径也是同一个** —— 从「可能同名」变成「必然同路径」。
  //   记号一样 ⇒ start.ps1 的 Test-IsOwnProcess 把 B 的进程认成 A 的 ⇒
  //   A 占着端口时 B 永远起不来，而且不报任何错。
  // ⛔ 这条用例必须用**同一个 entry**（这正是宿主的形态），
  //   不能像上面那条那样靠 dir 不同蒙混过关。
  const host = { entry: '../../lib/engines/host.py', args: ['--profile-json', '{profile_json}'] }
  const a = buildLaunchPlan(
    fakeProfile({ id: 'a', dir: path.join(ROOT, 'engines', 'a'), runtime: host }),
    { rootDir: ROOT, profileJsonPath: path.join(ROOT, 'cache', 'engines', 'a.profile.json') })
  const b = buildLaunchPlan(
    fakeProfile({ id: 'b', dir: path.join(ROOT, 'engines', 'b'), runtime: host }),
    { rootDir: ROOT, profileJsonPath: path.join(ROOT, 'cache', 'engines', 'b.profile.json') })

  assert.equal(a.entry, b.entry, '前提：两台走的确实是同一个宿主入口')
  assert.notEqual(a.own_process_mark, b.own_process_mark,
    '两台都走通用宿主时记号撞了 —— 后一台会被当成前一台，静默起不来')
  // ⭐ 记号必须真的出现在命令行里，否则 Contains() 永远命中不了。
  assert.ok(a.args.map((x) => x.toLowerCase()).includes(a.own_process_mark),
    '记号不在 args 里 = Test-IsOwnProcess 认不出自家进程')
})

test('⭐ launchPlan: 不走宿主的引擎，记号仍是入口绝对路径（行为不变）', () => {
  // 上一条的修法只该影响走宿主的那些。GPT-SoVITS 自带入口，一个字节都不该变。
  const plan = buildLaunchPlan(fakeProfile({ runtime: { entry: 'Run.PY' } }), { rootDir: ROOT })
  assert.equal(plan.own_process_mark, path.resolve(ROOT, 'engines/fake/Run.PY').toLowerCase())
  assert.equal(plan.profile_json_path, null,
    '没用 {profile_json} 的引擎不该被要求写一份没人读的名片文件')
})

// ===========================================================================
//  四点二、{profile_json} —— 通用宿主的接线
// ===========================================================================

test('⭐⭐ launchPlan: {profile_json} 展开成调用方给的路径，并挂出落盘指令', () => {
  const dest = path.join(ROOT, 'cache', 'engines', 'fake.profile.json')
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['--profile-json', '{profile_json}', '--port', '{port}'] } }),
    { rootDir: ROOT, profileJsonPath: dest })
  assert.deepEqual(plan.args, ['--profile-json', path.normalize(dest), '--port', '9999'])
  // ⭐ 这个字段是给调用方的**指令**：它在 = spawn 之前必须把名片写到那儿。
  assert.equal(plan.profile_json_path, path.normalize(dest))
})

test('⭐⭐ launchPlan: 不传 profileJsonPath 也能算出来（调用方没有可忘的东西）', () => {
  // ⛔ 第一版是「不传就抛」，报错写得很漂亮 —— 然后盘上真名片的三组体检
  //   当场全红：它们只想算个计划，凭什么关心一份缓存文件放哪儿。
  //   ⇒ 与其把报错写好，不如让这个错**不可能发生**。这条钉住那个决定。
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['--profile-json', '{profile_json}'] } }),
    { rootDir: ROOT })
  assert.equal(plan.profile_json_path,
    path.normalize(path.join(ROOT, 'cache', 'engines', 'fake.profile.json')))
  // ⭐ 落在 cache/ 下：这份文件完全可再生，删了下次启动自动重算。
  //   ⛔ 不该落进 outputs/ —— 那是给用户看的产物，不是平台的中间件。
  assert.ok(plan.profile_json_path.includes(`${path.sep}cache${path.sep}`))
})

test('⭐ launchPlan: 传了 profileJsonPath 但名片没用它 ⇒ 不落盘、不多字段', () => {
  // ⛔ 判据只能是「展开时命中过」，不能是「调用方传了路径」——
  //   后者会让一台压根不走宿主的引擎也白写一份没人读的文件到盘上。
  const plan = buildLaunchPlan(fakeProfile(), {
    rootDir: ROOT, profileJsonPath: path.join(ROOT, 'cache', 'engines', 'fake.profile.json'),
  })
  assert.equal(plan.profile_json_path, null)
})

test('⛔ launchPlan: {profile_json} 是路径，必须按本机分隔符规整', () => {
  // Windows 上不 normalize 会传出 "D:\...\cache/engines/x.profile.json"
  // 这种混着两种分隔符的串。这条钉的是它进了 PATHISH 那张表。
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { args: ['{profile_json}'] } }),
    { rootDir: ROOT, profileJsonPath: 'cache/engines/fake.profile.json' })
  assert.equal(plan.args[0], path.normalize(path.resolve(ROOT, 'cache/engines/fake.profile.json')))
})

// ===========================================================================
//  四点五、探活地址
// ===========================================================================

test('launchPlan: ready_url 用名片写的 ready_endpoint，不是写死的 /', () => {
  // ⛔ 突变验证抓到过：把 ready_endpoint 换成写死的 '/' 时全绿 —— 因为
  //   当时唯一被断言的那台引擎，ready_endpoint 本来就是 '/'。
  //   一条守卫必须至少覆盖两个不同的取值，否则它钉不住任何东西。
  const plan = buildLaunchPlan(
    fakeProfile({ runtime: { ready_endpoint: '/health' } }), { rootDir: ROOT })
  assert.equal(plan.ready_url, 'http://127.0.0.1:9999/health')
})

test('launchPlan: 真名片的 ready_endpoint 各不相同，且都被原样拼进 ready_url', () => {
  const { listEngineIds } = require('./registry')
  const seen = new Set()
  for (const id of listEngineIds()) {
    const profile = resolveEngineProfile(id, {})
    const plan = buildLaunchPlan(profile, { rootDir: ROOT })
    if (!plan.launchable) continue
    const ep = profile.runtime.ready_endpoint
    assert.ok(plan.ready_url.endsWith(ep), `${id} 的 ready_url 没用上名片的 ${ep}`)
    seen.add(ep)
  }
  assert.ok(seen.size >= 2,
    '盘上两台引擎的探活地址应当不同（"/" 和 "/health"）；' +
    '都一样的话上面那条断言就钉不住"有没有真读名片"')
})

// ===========================================================================
//  五、不由平台起的引擎
// ===========================================================================

test('launchPlan: 名片没有 runtime 时 launchable=false，且不是抛异常', () => {
  // 「这台引擎不由平台起」是合法状态（作者自己起 / 还没接上电），
  // ⭐ 但必须一眼能和「能起」分开，否则启动脚本会去 spawn 一个 undefined。
  const p = fakeProfile()
  p.runtime = null
  const plan = buildLaunchPlan(p, { rootDir: ROOT })
  assert.equal(plan.launchable, false)
  assert.ok(plan.reason.includes('不由平台启动'))
  assert.equal(plan.python, undefined)
  assert.equal(plan.entry, undefined)
})

test('launchPlan: 能起的时候 launchable=true', () => {
  assert.equal(buildLaunchPlan(fakeProfile(), { rootDir: ROOT }).launchable, true)
})

// ===========================================================================
//  六、⭐⭐ 黄金样本：GPT-SoVITS 的计划必须逐字等于 start.ps1 写死的那套
// ===========================================================================
//
// 下面这些期望值是从搬家前的 tools/scripts/start.ps1 抄下来的，不是从
// launchPlan.js 反推的：
//
//   :49  $ENGINE_SCRIPT = Join-Path $BASE_DIR 'lib\inference\infer_server.py'
//   :50  $ENGINE_CFG    = Join-Path $BASE_DIR 'lib\inference\tts_infer.yaml'
//   :48  $ENGINE_PY     = Join-Path $BASE_DIR 'venv\Scripts\python.exe'
//   :51  $ENGINE_HOST   = '127.0.0.1'
//   :52  $ENGINE_PORT   = 9880
//   :149 $hay.Contains('infer_server.py')
//   :283 @($ENGINE_SCRIPT,'-a',$ENGINE_HOST,'-p',"$ENGINE_PORT",'-c',$ENGINE_CFG)
//   :284 -WorkingDirectory $BASE_DIR
//
// ⚠ 这一组读**盘上的真名片**（和上面的夹具相反）—— 因为它要回答的问题
//   就是「今天盘上这张名片，起出来的是不是原来那台引擎」。名片改坏了，
//   这里就该红。

const { resolveEngineProfile } = require('./profile')

test('⭐⭐ 黄金样本：gpt-sovits 的启动计划逐字等于搬家前的 start.ps1', () => {
  const profile = resolveEngineProfile('gpt-sovits', {})   // 空 env：不让任何变量插手
  const plan = buildLaunchPlan(profile, { rootDir: ROOT })

  assert.equal(plan.launchable, true)
  assert.equal(plan.python, path.join(ROOT, 'venv', 'Scripts', 'python.exe'))
  assert.equal(plan.entry, path.join(ROOT, 'lib', 'inference', 'infer_server.py'))
  assert.equal(plan.cwd, ROOT)
  assert.equal(plan.host, '127.0.0.1')
  assert.equal(plan.port, 9880)
  assert.deepEqual(plan.args, [
    '-a', '127.0.0.1',
    '-p', '9880',
    '-c', path.join(ROOT, 'lib', 'inference', 'tts_infer.yaml'),
  ])
  // ready 探活打的是 "/" —— infer_server.py:525 的 @APP.get("/")。
  // ⛔ 别照着 IndexTTS2 抄成 /health，那个地址在这台引擎上不存在。
  assert.equal(plan.ready_url, 'http://127.0.0.1:9880/')
  // 老写法 Contains('infer_server.py') 命中的东西，新记号也必须命中。
  assert.ok(plan.own_process_mark.endsWith('infer_server.py'))
})

test('⭐⭐ 黄金样本：GPT_SOVITS_BASE_URL 指向远程时，仍然在本地起本地端口', () => {
  // ⛔ 突变验证抓到过：让 profile.js 在 env 命中时把 env 地址也当成
  //   declared_base_url，全绿 —— 因为上面所有用例都传空 env，
  //   而 launchPlan 那边的用例又是自造 profile，两边都没走过这条真路。
  //   ⭐ 这正是「凡为测试开的缝，必须另有一条走真实默认路径的测试」。
  //
  // 真实场景：有人把引擎跑在另一台机器上，于是设了 GPT_SOVITS_BASE_URL。
  // 「连哪儿」应当跟着变，「听哪儿」不能变 —— 否则 start.ps1 会在本地
  // 起一台监听远程端口号的引擎。
  const env = { GPT_SOVITS_BASE_URL: 'http://10.0.0.7:7777' }
  const profile = resolveEngineProfile('gpt-sovits', env)

  assert.equal(profile.base_url, 'http://10.0.0.7:7777', '连哪儿：该被 env 顶掉')
  assert.equal(profile.base_url_source, 'env:GPT_SOVITS_BASE_URL')
  assert.equal(profile.default_base_url, 'http://127.0.0.1:9880', '听哪儿：env 顶不动')

  const plan = buildLaunchPlan(profile, { rootDir: ROOT })
  assert.equal(plan.host, '127.0.0.1')
  assert.equal(plan.port, 9880)
  assert.deepEqual(plan.args.slice(0, 4), ['-a', '127.0.0.1', '-p', '9880'])
  assert.ok(!JSON.stringify(plan).includes('10.0.0.7'),
    '启动计划里不该出现任何 env 顶出来的地址')
})

test('⭐ 黄金样本：端口被挪走时，命令行里那个 -p 要跟着挪', () => {
  // 搬家前 start.ps1 把 "$ENGINE_PORT"（已解冲突的值）塞进 -p。
  // 要是这里还发名片上的 9880，引擎会听在一个没人连的端口上，
  // 而 /api/health 探的是新端口 ⇒ 表现为「引擎永远不上线」。
  const profile = resolveEngineProfile('gpt-sovits', {})
  const plan = buildLaunchPlan(profile, { rootDir: ROOT, port: 9890 })
  const i = plan.args.indexOf('-p')
  assert.ok(i >= 0, '-p 得还在')
  assert.equal(plan.args[i + 1], '9890')
  assert.equal(plan.ready_url, 'http://127.0.0.1:9890/')
  assert.equal(plan.desired_port, 9880)
})

test('⭐ 盘上每一张写了 runtime 的真名片都要能算出计划', () => {
  // 体检，不是黄金样本：新加引擎时这条会自动覆盖到它。
  const { listEngineIds } = require('./registry')
  let checked = 0
  for (const id of listEngineIds()) {
    const profile = resolveEngineProfile(id, {})
    const plan = buildLaunchPlan(profile, { rootDir: ROOT })
    if (!plan.runtime && plan.launchable === false) continue
    checked += 1
    assert.equal(plan.launchable, true, `${id} 写了 runtime 却算不出计划`)
    assert.ok(path.isAbsolute(plan.python), `${id} 的 python 不是绝对路径`)
    assert.ok(path.isAbsolute(plan.entry), `${id} 的 entry 不是绝对路径`)
    assert.ok(path.isAbsolute(plan.cwd), `${id} 的 cwd 不是绝对路径`)
    // ⛔ 展开后不许还剩花括号 —— 那说明有占位符漏填了。
    for (const a of plan.args) {
      assert.ok(!/[{}]/.test(a), `${id} 的 args 里还剩没展开的占位符：${a}`)
    }
    assert.ok(plan.ready_url.startsWith(`http://${plan.host}:${plan.port}/`),
      `${id} 的 ready_url 拼错了：${plan.ready_url}`)
    assert.ok(plan.ready_timeout_ms > 0)
  }
  assert.ok(checked >= 2, `盘上至少该有两台能起的引擎，实际 ${checked}`)
})

test('⭐⭐ 盘上每张名片的 args 里都不许写死端口号', () => {
  // ⛔ 突变验证抓到过：把 IndexTTS2 名片里的 "{port}" 换成字面量 "9881"，
  //   全绿 —— 因为没有任何一条测试拿一个**挪走过的**端口去问它。
  //   写死的后果不是报错，是「引擎起来了，但听在没人连的端口上」，
  //   而 start.ps1 探的是新端口 ⇒ 表现为「引擎永远不上线」。
  //
  // 判据：带着一个和名片不同的端口去算，算出来的命令行里就不该再有
  // 名片上那个端口号。这条对任何新引擎自动生效，不用为它写新测试。
  const { listEngineIds } = require('./registry')
  let checked = 0
  for (const id of listEngineIds()) {
    const profile = resolveEngineProfile(id, {})
    const probe = buildLaunchPlan(profile, { rootDir: ROOT })
    if (!probe.launchable) continue
    const shifted = probe.desired_port + 7
    const plan = buildLaunchPlan(profile, { rootDir: ROOT, port: shifted })
    const line = plan.args.join(' ')
    assert.ok(!line.includes(String(probe.desired_port)),
      `${id} 的 args 里写死了端口 ${probe.desired_port}：${line}`)
    assert.ok(line.includes(String(shifted)),
      `${id} 的 args 里没有实际端口 ${shifted} —— 引擎不会听在平台以为的地方：${line}`)
    checked += 1
  }
  assert.ok(checked >= 2, `该检查的引擎至少两台，实际 ${checked}`)
})

test('⭐⭐ 不由平台启动的引擎，照样要给出它的地址', () => {
  // 地址和「谁来起它」是两件事：不写 runtime 只是说"作者自己起"，
  // 但后端还是要连它，start.ps1 的端口保护也还是要护着它那个端口。
  const p = fakeProfile()
  delete p.runtime
  const plan = buildLaunchPlan(p, { rootDir: ROOT })
  assert.equal(plan.launchable, false)
  assert.ok(plan.reason, '要说清为什么不可启动')
  // ⛔ 下面这四条是这条测试的正题。少了它们，PowerShell 拿到 $null，
  //   [int]$null = 0，Resolve-Port 去问「谁在听 0 号端口」—— 永远没有，
  //   于是端口冲突保护对这台引擎静默失效，而没有任何东西会报错。
  assert.equal(plan.host, '127.0.0.1')
  assert.equal(plan.port, 9999)
  assert.equal(plan.desired_port, 9999)
  assert.equal(plan.base_url, 'http://127.0.0.1:9999')
  // 但"怎么起"的那几样必须一个都没有 —— 有了就会被拿去 spawn。
  for (const k of ['python', 'entry', 'args', 'cwd']) {
    assert.equal(plan[k], undefined, `不可启动却给出了 ${k}，调用方会拿它去起进程`)
  }
})

test('⭐ 写了 runtime 却漏了 args：报的话必须人能看懂', () => {
  // 这是接第三台引擎的人最可能踩的一格。不查形状的话这里抛的是
  // "Cannot read properties of undefined (reading 'map')" —— 那句话
  // 会一路传到用户的启动窗口，而它一个字都没说是哪张名片少了哪个字段。
  // ⚠ fakeProfile 的默认值里 args 是 []，所以要显式删掉才能造出「漏写」。
  const bad = fakeProfile()
  delete bad.runtime.args
  const e = grab(() => buildLaunchPlan(bad, { rootDir: ROOT }))
  assert.equal(e.code, 'ENGINE_LAUNCH_ARGS_INVALID')
  assert.ok(e.message.includes(bad.id), '要指名道姓说是哪台引擎')
  assert.ok(e.message.includes('runtime.args'), '要说清是哪个字段')
  assert.ok(e.message.includes('[]'), '要告诉人不需要参数时该怎么写')

  // 写成别的类型同样要拦（写字符串是很自然的手误）。
  const str = fakeProfile({ runtime: { args: '-p 9880' } })
  assert.equal(grab(() => buildLaunchPlan(str, { rootDir: ROOT })).code, 'ENGINE_LAUNCH_ARGS_INVALID')

  // 数组里混进非字符串也要拦：JSON 里 9880 和 "9880" 长得几乎一样。
  const num = fakeProfile({ runtime: { args: ['-p', 9880] } })
  assert.equal(grab(() => buildLaunchPlan(num, { rootDir: ROOT })).code, 'ENGINE_LAUNCH_ARGS_INVALID')

  // ⭐ 守卫自验：空数组必须放行，否则这条断言顺手禁掉了一种合法名片
  //   （靠配置文件、不需要任何命令行参数的引擎）。
  const empty = fakeProfile({ runtime: { args: [] } })
  assert.deepEqual(buildLaunchPlan(empty, { rootDir: ROOT }).args, [])
})

// ===========================================================================
//  七、CLI —— tools/scripts/*.ps1 只通过它说话
// ===========================================================================

const { execFileSync } = require('node:child_process')
const CLI = path.join(__dirname, 'engine-launch-plan.cjs')

// ⭐ 第二个参数是**给子进程加的环境变量**，不是给 CLI 的参数。
//   它存在的唯一理由见下面那条「一张名片坏了」的用例：坏名片必须造在
//   临时目录里，而 CLI 认哪个目录是靠 lib/paths.js 的 ENGINES_DIR。
function cli(args, extraEnv) {
  const opts = { encoding: 'utf8' }
  if (extraEnv) opts.env = Object.assign({}, process.env, extraEnv)
  try {
    const out = execFileSync(process.execPath, [CLI].concat(args), opts)
    return { code: 0, json: JSON.parse(out) }
  } catch (e) {
    return { code: e.status, json: JSON.parse(String(e.stdout)) }
  }
}

test('CLI: --engine 出一份计划，退出码 0', () => {
  const r = cli(['--engine', 'gpt-sovits'])
  assert.equal(r.code, 0)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.port, 9880)
})

test('CLI: --port 会覆盖', () => {
  const r = cli(['--engine', 'gpt-sovits', '--port', '9890'])
  assert.equal(r.json.port, 9890)
  assert.equal(r.json.desired_port, 9880)
})

test('⭐ CLI: 出错时 stdout 也是一行合法 JSON，退出码非 0', () => {
  // ⛔ 这条不是洁癖：调用方是 PowerShell 的 ConvertFrom-Json。错误信息要是
  //   只走 stderr，PS 那边拿到的是空串，报出来的会是「不是合法 JSON」——
  //   把人从「引擎名字写错了」引到「脚本坏了」。
  for (const bad of [['--engine', 'nope'], []]) {
    const r = cli(bad)
    assert.notEqual(r.code, 0, `${JSON.stringify(bad)} 该非零退出`)
    assert.equal(r.json.ok, false)
    assert.ok(r.json.error && r.json.code, '要带上人能看懂的 error 和机器能认的 code')
  }
})

test('⭐⭐ CLI --all: 列出每台引擎的默认监听端口（stop.ps1 靠它）', () => {
  const r = cli(['--all'])
  assert.equal(r.code, 0)
  assert.equal(r.json.ok, true)
  const ids = r.json.engines.map((e) => e.id).sort()
  assert.deepEqual(ids, ['gpt-sovits', 'indextts2'])
  for (const e of r.json.engines) {
    assert.equal(e.ok, true)
    assert.equal(e.launchable, true)
    assert.ok(Number.isInteger(e.port) && e.port > 0, `${e.id} 没给出端口`)
  }
})

test('⭐⭐ CLI --all: 一张名片坏了，不许连累其他引擎', () => {
  // 停止脚本的可靠性高于报错的严谨性：停不掉的进程会锁住文件。
  // ⚠ 这条靠临时造一张坏名片来验 —— 不改盘上的真名片。
  // ⚠ 目录名不能以 _ 或 . 开头：registry.js:81 把它们当模板/隐藏目录跳过
  //   （_TEMPLATE 就是这么被排除的）。我第一版就踩了这个，表现是
  //   「坏名片压根没出现在列表里」，看着像 --all 把它吞了。
  //
  // ⛔⛔ 这张坏名片**不许落在真的 engines/ 目录里**（2026-08-30 真机事故）：
  //   `node --test` 是**多文件并行**的，别的测试文件此刻正在另外的进程里
  //   扫同一个 engines/ 目录。它们会读到这张名片 —— 而且在 writeFileSync
  //   建好文件、内容还没写进去的那一瞬间读到的是 **0 字节** ⇒
  //   registry.js:52 抛 ENGINE_MANIFEST_INVALID（Unexpected end of JSON input）
  //   ⇒ 别的文件里的用例表现成「/api/engines 500」「配方存不进」「合成 500」。
  //   那次读数是 1093 tests / 65 fail，其中 18 条的错误原文直接点着
  //   engines\zzbrokenprobe\manifest.json，另外几十条是它的下游级联。
  //   ⇒ **测试之间唯一的共享状态就是这个目录，谁都不许往里写。**
  //
  // ⭐ 逃生口是 lib/paths.js:222 `ENGINES_DIR = envDir('ENGINES_DIR', …)`：
  //   CLI 是**子进程**，给它一个临时 ENGINES_DIR 就行，真名片只读地拷进去
  //   （拷的是名片本身，所以「好的那台照常」验的仍是真名片的数）。
  const fs = require('node:fs')
  const os = require('node:os')
  const realDir = path.join(ROOT, 'engines')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-engines-'))
  try {
    for (const name of fs.readdirSync(realDir)) {
      if (name.startsWith('_') || name.startsWith('.')) continue
      const src = path.join(realDir, name, 'manifest.json')
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(path.join(sandbox, name), { recursive: true })
      fs.copyFileSync(src, path.join(sandbox, name, 'manifest.json'))
    }
    const brokenDir = path.join(sandbox, 'zzbrokenprobe')
    fs.mkdirSync(brokenDir, { recursive: true })
    fs.writeFileSync(path.join(brokenDir, 'manifest.json'), JSON.stringify({
      id: 'zzbrokenprobe',
      label: { en: 'broken', zh: 'broken' },
      // ⛔ 故意不写 default_base_url —— launchPlan 会抛
      runtime: { python: 'x/py.exe', entry: 'e.py', ready_endpoint: '/' },
    }), 'utf8')

    const r = cli(['--all'], { ENGINES_DIR: sandbox })
    assert.equal(r.code, 0, '一张坏名片不该让整个列表失败')
    const broken = r.json.engines.find((e) => e.id === 'zzbrokenprobe')
    const good = r.json.engines.find((e) => e.id === 'gpt-sovits')
    assert.ok(broken, '坏的那台也要出现在列表里，带着原因')
    assert.equal(broken.ok, false)
    assert.ok(broken.error, '要说清它为什么算不出来')
    assert.ok(good && good.ok && good.port === 9880, '好的那台必须照常')
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }

  // ⭐ 自证这一条真的没碰真目录 —— 断言写在这里，是因为「弄脏了别人」这件事
  //   本身不会让这条用例变红，只会让**别的文件**莫名其妙红。
  assert.ok(!fs.existsSync(path.join(realDir, 'zzbrokenprobe')),
    '这条用例把假名片留在了真的 engines/ 目录里 —— 并行跑的其他测试会读到它')
})

test('⭐ 两台真引擎的默认监听端口不许撞', () => {
  // 撞了的表现是「起了 B 之后 A 莫名其妙起不来」，而两张名片各自看都没问题。
  const { listEngineIds } = require('./registry')
  const seen = new Map()
  for (const id of listEngineIds()) {
    const plan = buildLaunchPlan(resolveEngineProfile(id, {}), { rootDir: ROOT })
    if (!plan.launchable) continue
    const key = `${plan.host}:${plan.desired_port}`
    assert.ok(!seen.has(key),
      `${id} 和 ${seen.get(key)} 的默认监听地址都是 ${key}`)
    seen.set(key, id)
  }
})

// ---------------------------------------------------------------------------
//  下面这几条守的是 tools/scripts/start.ps1 依赖的约定
// ---------------------------------------------------------------------------
// ⚠ 它们**测不到 start.ps1 本身**（PowerShell，跑不了）。它们测的是那个脚本
//   张口就要的几个字段：少一个，脚本不会报错，它会安安静静地起错端口、
//   或者让后端连到一个没人监听的地址上去。那种故障最难查，所以在这里挡住。

// 「不由平台启动」的引擎档案：有地址，没 runtime。
function noRuntime(over = {}) {
  const p = fakeProfile(over)
  p.runtime = null
  return p
}

test('⭐⭐ CLI --all: 不由平台启动的引擎也要给出 label/host/port', () => {
  // start.ps1 的端口保护对这种引擎同样生效 —— 作者自己起的引擎照样占着
  // 它那个端口，别的程序不该抢。
  // ⛔ 老写法只回 {id, ok, launchable:false}，PowerShell 那边拿到 $null，
  //   [int]$null = 0，于是拿 0 号端口去问「有人在听吗」——永远没有，
  //   端口保护对这台**静默失效**。静默，所以必须由测试来喊。
  //
  // ⚠ 夹具取自盘上一张**真** manifest.json，只摘掉 runtime 和换掉地址。
  //   ⛔ 别手拼一张三行的：我第一版就是那么写的，红在「缺 timeout_ms」——
  //     红的是夹具不是产品。契约将来再加必填字段，手拼的那张会再红一次，
  //     而这一条测的根本不是「字段齐不齐」。
  //
  // ⛔⛔ 和下面那条坏名片用例同一条纪律：这台假引擎**不许落在真的 engines/ 里**。
  //   它的名片本身是合法的，所以不会像 zzbrokenprobe 那样把别人炸成 500 ——
  //   它的害处更安静：并行跑的别的文件会**多看见一台引擎**，
  //   `deepEqual(ids, ['gpt-sovits','indextts2'])` 这类断言随机变红。
  //   ⇒ 同样走 lib/paths.js:222 的 ENGINES_DIR 逃生口。
  const fs = require('node:fs')
  const os = require('node:os')
  const realDir = path.join(ROOT, 'engines')
  const src = JSON.parse(
    fs.readFileSync(path.join(realDir, 'indextts2', 'manifest.json'), 'utf8'))
  delete src.runtime // ⛔ 这台引擎由作者自己起
  src.id = 'zznoruntimeprobe'
  src.default_base_url = 'http://127.0.0.1:9999'
  delete src.base_url_env // 免得和真引擎抢同一个环境变量名
  delete src.legacy_default
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-engines-'))
  const dir = path.join(sandbox, 'zznoruntimeprobe')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(src), 'utf8')
  try {
    const r = cli(['--all'], { ENGINES_DIR: sandbox })
    assert.equal(r.code, 0)
    const e = r.json.engines.find((x) => x.id === 'zznoruntimeprobe')
    assert.ok(e, '不由平台启动的引擎也要出现在列表里')
    assert.equal(e.ok, true, '算得出来就是 ok —— 「不启动」不是「读不出来」')
    assert.equal(e.launchable, false)
    assert.equal(e.host, '127.0.0.1', '没有 host，端口保护就守不住它')
    assert.equal(e.port, 9999, '没有 port，PowerShell 会拿 0 号端口去问')
    assert.ok(e.label, '没有 label，启动摘要里这台会是一行空白')
    assert.equal(e.error, undefined, `算不出来了：${e.error}`)
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true })
  }

  assert.ok(!fs.existsSync(path.join(realDir, 'zznoruntimeprobe')),
    '这条用例把假引擎留在了真的 engines/ 目录里 —— 并行跑的其他测试会多看见一台')
})

test('⭐⭐ 启动计划要交出 base_url_env 的**名字**，不只是读取结果', () => {
  // start.ps1 起多台时，得把每台定下来的地址各自写进各自的变量。
  // 它只能从这里知道该写哪个变量名 —— 脚本里再也不许出现
  // GPT_SOVITS_BASE_URL 这几个字。
  const r = cli(['--engine', 'gpt-sovits'])
  assert.equal(r.code, 0)
  assert.equal(r.json.base_url_env, 'GPT_SOVITS_BASE_URL')
})

test('⭐ 不由平台启动的引擎，也要交出 base_url_env', () => {
  // 端口被别的程序占走要挪，挪完后端得跟得上 —— 靠的就是往这个变量里写。
  // 这台引擎虽然不由平台启动，端口一样会被挪。
  const plan = buildLaunchPlan(
    noRuntime({ base_url_env: 'ZZ_PROBE_URL' }),
    { rootDir: ROOT })
  assert.equal(plan.launchable, false)
  assert.equal(plan.base_url_env, 'ZZ_PROBE_URL')
})

test('⭐ 没写 base_url_env 的引擎，这里是 null 而不是缺字段', () => {
  // null 和「没有这个键」在 PowerShell 里都会变成空字符串，看着一样；
  // 但缺字段意味着「谁也没想过这件事」，null 意味着「想过，这台没有」。
  // start.ps1 靠它决定要不要在挪端口时红字警告。
  const plan = buildLaunchPlan(
    noRuntime({}),
    { rootDir: ROOT })
  assert.ok('base_url_env' in plan, '键必须在')
  assert.equal(plan.base_url_env, null)
})

// ===========================================================================
//  八、这一次要装哪一份模型（顶替底模目录）
// ===========================================================================

test('⭐⭐ 选中的那一份模型顶替 {checkpoints}，命令行跟着变', () => {
  const p = fakeProfile({
    runtime: {
      checkpoints: 'models/base',
      args: ['--model-dir', '{checkpoints}', '--cfg', '{checkpoints}/config.yaml'],
    },
  })
  const before = buildLaunchPlan(p, { rootDir: ROOT })
  assert.equal(before.args[1], path.normalize(path.resolve(ROOT, 'models/base')))

  const after = buildLaunchPlan(p, {
    rootDir: ROOT,
    checkpointsOverride: 'assets/somebody/models/fake/model/finetuned',
  })
  const want = path.resolve(ROOT, 'assets/somebody/models/fake/model/finetuned')
  assert.equal(after.args[1], path.normalize(want))
  assert.equal(after.args[3], path.normalize(path.join(want, 'config.yaml')),
    '从 {checkpoints} 长出来的**每一个**路径都要跟着挪，不能只挪第一个')
  assert.equal(after.checkpoints, want)
})

test('⛔ 不传顶替值时，行为一个字节不变', () => {
  const p = fakeProfile({ runtime: { checkpoints: 'models/base', args: ['-c', '{checkpoints}'] } })
  const a = buildLaunchPlan(p, { rootDir: ROOT })
  const b = buildLaunchPlan(p, { rootDir: ROOT, checkpointsOverride: null })
  const c = buildLaunchPlan(p, { rootDir: ROOT, checkpointsOverride: '' })
  assert.deepEqual(b, a)
  assert.deepEqual(c, a)
})

test('⭐ 顶替值按项目根解析，不按引擎目录', () => {
  // 盘上模型登记的是相对路径。按引擎目录解会解到 engines/<id>/ 底下去，
  // 那儿什么都没有 —— 而报错会来自引擎「找不到文件」，指向完全错误的方向。
  const p = fakeProfile({ runtime: { checkpoints: 'models/base', args: ['-c', '{checkpoints}'] } })
  const plan = buildLaunchPlan(p, { rootDir: ROOT, checkpointsOverride: 'assets/a/models/fake/m/x' })
  assert.equal(plan.checkpoints, path.resolve(ROOT, 'assets/a/models/fake/m/x'))
})

test('⭐ 名片没写 checkpoints，但这一次选了一份 ⇒ 能用，不抛', () => {
  // 「名片没写默认底模」和「这一次不知道用哪份」是两件事。
  const p = fakeProfile({ runtime: { checkpoints: null, args: ['-c', '{checkpoints}'] } })
  assert.throws(() => buildLaunchPlan(p, { rootDir: ROOT }), /checkpoints/)
  const plan = buildLaunchPlan(p, { rootDir: ROOT, checkpointsOverride: 'assets/a/models/fake/m/x' })
  assert.equal(plan.args[1], path.normalize(path.resolve(ROOT, 'assets/a/models/fake/m/x')))
})

// ===========================================================================
//  九、开机要不要点着它（preload 不再照抄名片）
// ===========================================================================

test('⭐⭐⭐ 模型是开进程那一步吃进去的 ⇒ 开机不点着，哪怕名片写 preload:true', () => {
  // 这条就是这一刀的全部理由：那种引擎一起进程就吃掉好几 G 内存，
  // 装第四台就是四份内存一起吃，而用户可能一次都没用到它。
  const p = fakeProfile({
    runtime: { preload: true },
    weight_slots: [{ name: 'model', applies_at: 'launch' }],
  })
  assert.equal(buildLaunchPlan(p, { rootDir: ROOT }).preload, false)
  assert.equal(buildLaunchPlan(p, { rootDir: ROOT }).on_demand, true)
})

test('进程只是个壳（模型是调用时喂进去的）⇒ 照常开机点着', () => {
  const p = fakeProfile({
    runtime: { preload: true },
    weight_slots: [{ name: 'a', applies_at: 'call', param: 'pa' }],
  })
  const plan = buildLaunchPlan(p, { rootDir: ROOT })
  assert.equal(plan.preload, true)
  assert.equal(plan.on_demand, false)
})

test('⛔ 名片写 preload:false 仍然一票否决', () => {
  const p = fakeProfile({
    runtime: { preload: false },
    weight_slots: [{ name: 'a', applies_at: 'call', param: 'pa' }],
  })
  assert.equal(buildLaunchPlan(p, { rootDir: ROOT }).preload, false)
})

test('⭐⭐ 启动脚本必须**读**这个答案，⛔ 不许自己判', () => {
  // 弱守卫（PowerShell 跑不了），但拦得住最容易复发的那件事：
  // 有人在启动脚本里写一句「如果是那台吃内存的就别起」。那一句会让
  // 「加一台引擎不碰平台代码」当场破功。
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'scripts', 'start.ps1'), 'utf8')
  const code = src.split('\n').filter((ln) => !/^\s*#/.test(ln)).join('\n')
  assert.match(code, /\$plan0\.preload/, '启动脚本没有读计划里的 preload —— 那它凭什么决定起不起')
  for (const banned of ['indextts', 'sovits', 'gpt-']) {
    assert.ok(!code.toLowerCase().includes(banned),
      `start.ps1 里出现了 ${banned} —— 启动脚本里不许有任何一台具体引擎的知识（契约 §9）`)
  }
})

test('⚠ 不由平台启动的引擎，preload / on_demand 两个键都要在，且都是 false', () => {
  const plan = buildLaunchPlan(noRuntime({}), { rootDir: ROOT })
  assert.ok('preload' in plan && 'on_demand' in plan, '缺键会在下游静默变成 false，洞永远发现不了')
  assert.equal(plan.preload, false)
  assert.equal(plan.on_demand, false)
})
