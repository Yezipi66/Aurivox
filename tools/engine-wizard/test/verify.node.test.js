'use strict'
// verify（第 5 步）：核心判据：平台四道校验，一个都不许重写。
// envCheck 的真实签名是 (profile, {rootDir})，猜错签名 node 不会报错，只是读到一堆 undefined。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { checks, runChecks, runAudioCheck } = require('../core/verify.js')
const { listEngines } = require('../../../lib/engines/registry')

// 用一台真引擎（测试里只当字符串用，不 import 它的任何东西）
const REAL = listEngines()[0]?.id || 'gpt-sovits'

// 清单 ： 四道，顺序照平台
test('四道校验都在，顺序是环境、导入、权重、合成', () => {
  const ks = checks().map((c) => c.key)
  assert.deepStrictEqual(ks,
    ['env_shallow', 'env_deep', 'checkpoints', 'audio'])
})

test('每道都要带 why（用户要知道这道在查什么）', () => {
  for (const c of checks()) {
    assert.ok(c.why && c.why.length > 8, `${c.key} 缺 why`)
    assert.ok(c.titleZh, `${c.key} 缺中文标题`)
  }
})

test('合成校验标为耗时项：它会执行一次真实合成', () => {
  const audio = checks().find((c) => c.key === 'audio')
  assert.strictEqual(audio.cost, 'heavy',
    '必须标明这道要真跑合成，别让用户以为它跟查盘一样快')
})

// 真跑 ： 签名猜错只有这条路能发现
test('真跑前 3 道（不跑出声那道）', () => {
  const r = runChecks(REAL, { deep: true })
  assert.strictEqual(r.id, REAL)
  // 浅层必须返回了东西 ： 签名猜错的话这里会是 undefined
  assert.ok(r.checks.env_shallow, '浅层没返回结果 —— envCheck 签名可能又猜错了')
  assert.strictEqual(typeof r.checks.env_shallow.ok, 'boolean',
    `浅层没给 ok —— 拿到的是 ${JSON.stringify(r.checks.env_shallow).slice(0, 200)}`)
  assert.ok(Array.isArray(r.checks.env_shallow.problems),
    '浅层没给 problems 数组')
})

test('权重那道的 ready 必须是三态（不许糊成布尔）', () => {
  const r = runChecks(REAL, { deep: false })
  const cp = r.checks.checkpoints
  assert.ok(cp, '没有权重那道的结果')
  assert.ok([true, false, null].includes(cp.ready),
    `ready 只能是 true/false/null，拿到 ${JSON.stringify(cp.ready)}`)
  assert.ok(typeof cp.note === 'string' && cp.note.length > 4, '三态各有各的说法')
  // ready:null 时的说法必须点明「这不是齐，也不是缺」
  if (cp.ready === null) {
    assert.ok(cp.note.includes('说不出来'), cp.note)
  }
})

test('权重说不出来时，整轮不能报通过', () => {
  const r = runChecks(REAL, { deep: false })
  if (r.checks.checkpoints.ready === null) {
    assert.ok(r.problems.some((p) => p.includes('说不出来')),
      '权重说不出来，却没进 problems —— 那等于偷偷当成通过了')
  }
})

// 第 4 道「语音合成可用性」：A 级未提供请求时不执行
test('A 级未提供请求时不执行，并说明平台不构造合成内容', async () => {
  const r = await runAudioCheck(REAL, { audio: 'A' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_REQUEST')
  // 理由需说明平台不构造请求体
  // error 已双语化（英文为主 + errorZh 中文），断言走 errorZh，两边都要钉。
  assert.ok(r.errorZh.includes('参数映射'), r.errorZh)
  assert.ok(/dialect/i.test(r.error), r.error)
  assert.ok(r.expected_shape, '要告诉用户请求体该长什么样')
})

test('B 级无需请求体：仅校验响应格式', async () => {
  const r = await runAudioCheck(REAL, { audio: 'B' })
  // 无论通过与否，结果都要带 ok 与 level
  assert.strictEqual(typeof r.ok, 'boolean', JSON.stringify(r).slice(0, 200))
  assert.ok(r.level === 'B' || r.code, '结果需带 level 或 code')
})

test('名片缺少 runtime 时如实说明无法确定启动方式', async () => {
  const r = await runAudioCheck('definitely-not-installed-xyz', { audio: 'B' })
  assert.strictEqual(r.ok, false)
  assert.ok(['NO_PROFILE', 'NO_RUNTIME'].includes(r.code), r.code)
})

// 没有常驻地址的引擎（stdio / cli 形态）：先拉临时宿主再验
//   整条链用注入测：拉起器拿到的是注入的假宿主，
//   但「verifyEngine 收到的 profile.base_url 被替换成本地地址」这条核心语义是真的。
const NO_URL_PROFILE = {
  id: 'stdio-engine', timeout_ms: 1000,
  runtime: { python: '.venv' }, // 有 runtime（能起），但没有 base_url
}

test('无 base_url 的引擎：拉起临时宿主，地址注入 verifyEngine 的 profile', async () => {
  const seen = {}
  const r = await runAudioCheck('stdio-engine', {
    audio: 'B',
    profile: NO_URL_PROFILE, manifest: {},
    verifyEngine (o) {
      seen.baseUrl = o.profile.base_url // 注入点：这就是 P0-2 要钉的那一格
      return { ok: true, level: 'B', steps: [] }
    },
    hostRunner: {
      async withTempHost (arg) {
        seen.id = arg.id
        // 真 run 回调会带注入后的地址：让它跑一次，验的是同一条链
        const result = await arg.run('http://127.0.0.1:59998')
        return { ok: true, base_url: 'http://127.0.0.1:59998', result }
      },
    },
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(seen.id, 'stdio-engine')
  assert.strictEqual(seen.baseUrl, 'http://127.0.0.1:59998',
    'verifyEngine 收到的 base_url 必须是临时宿主的地址')
})

test('有 base_url 的引擎：走老路，不拉临时宿主', async () => {
  let hostCalled = 0
  const r = await runAudioCheck('resident-engine', {
    audio: 'B',
    profile: { ...NO_URL_PROFILE, base_url: 'http://127.0.0.1:9881' },
    manifest: {},
    verifyEngine: () => ({ ok: true, level: 'B', steps: [] }),
    hostRunner: { async withTempHost () { hostCalled++; return { ok: true } } },
  })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(hostCalled, 0, '有常驻地址就别拉：白起一台占端口')
})

test('拉起失败：code=HOST_FAILED，stage 与宿主输出带回来', async () => {
  const r = await runAudioCheck('stdio-engine', {
    audio: 'B',
    profile: NO_URL_PROFILE, manifest: {},
    verifyEngine: () => { throw new Error('不该跑到这里') },
    hostRunner: {
      async withTempHost () {
        return { ok: false, stage: 'host-exit', base_url: 'http://127.0.0.1:1',
          error: '宿主进程提前退出（code=2）', stderr: 'No module named xx' }
      },
    },
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'HOST_FAILED')
  assert.ok(r.error.includes('host-exit'), 'stage 要带回来')
  assert.ok(r.errorZh.includes('宿主进程提前退出'),
    `errorZh 要把原因说成人话：${r.errorZh}`)
  assert.ok(!String(r.errorZh).includes('undefined'), 'errorZh 不能出现 undefined')
})

// 纪律
test('verify.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'verify.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('不许自己重写四道校验的判据（那等于两份事实）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'verify.js'), 'utf-8')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  // 四道都必须 require 平台的实现，而不是自己算
  for (const m of ['envCheck.js', 'checkpoints.js', 'verifyAudio.js']) {
    assert.ok(code.includes(m), `没有引用平台的 ${m}`)
  }
  // 也不许出现「重跑一遍 import」这类自己实现的痕迹
  assert.ok(!/spawnSync.*verify_audio|exec.*import /.test(code),
    '发现自己实现校验逻辑的痕迹')
})

// 标题与「这道查什么」随结果下发，界面不另造标签，避免与第 2 步「安装依赖」混淆。
test('每道结果带着平台自己的标题与说明，前端不再另造标签', () => {
  const r = runChecks(REAL, { deep: true })
  for (const k of ['env_shallow', 'env_deep', 'checkpoints']) {
    const c = r.checks[k]
    assert.ok(c && typeof c.titleZh === 'string' && c.titleZh.length > 0,
      `${k} 没带平台的 titleZh：界面拿不到平台词汇，只能自己造`)
    assert.ok(c && typeof c.whyZh === 'string' && c.whyZh.length > 4,
      `${k} 没带 whyZh：使用者看不出这道在查什么`)
  }
})

// 权重道不吃 problems：note / missing / abs_path 是平台查明的细节，
//   界面读它们才能把「目录不在、缺哪些文件」如实呈现。
test('权重道结果带着 note / missing / abs_path，界面不该只会读 problems', () => {
  const r = runChecks(REAL, { deep: false })
  const c = r.checks.checkpoints
  assert.ok(c, '没有权重道结果')
  assert.ok(typeof c.note === 'string' && c.note.length > 4,
    'note 缺失：平台查明了什么，没传给界面')
  assert.ok(Array.isArray(c.missing), 'missing 得是数组')
  assert.ok(c.abs_path === null || typeof c.abs_path === 'string',
    'abs_path 形状不对')
})
// 第 5 步的措辞要像正式界面：四道标题用名词短语，不用口语问句。
//   stage 把「静态前置核对」与「真实合成」分开，界面才能分两层报结论。
test('四道标题为正式名称，且按静态前置与运行验证分层', () => {
  const all = checks()
  assert.deepStrictEqual(all.map((c) => c.titleZh),
    ['运行环境完整性', '引擎模块可导入', '模型权重完整性', '语音合成可用性'])
  assert.deepStrictEqual(all.map((c) => c.stage),
    ['preflight', 'preflight', 'preflight', 'runtime'])
  for (const c of all) {
    assert.ok(!/[没不齐齐声][？?]?$/.test(c.titleZh), `${c.key} 的标题仍是口语问句`)
    assert.ok(c.titleEn && c.whyZh && c.why, `${c.key} 缺正式说明`)
  }
})

test('静态前置检查单独汇总，不与真实合成混为一个结论', (t) => {
  const r = runChecks(REAL, { deep: true })
  // 没有可用名片时 runChecks 只回 NO_PROFILE，没有可汇总的检查项。
  if (!r.checks) return t.skip('当前环境没有可解析的引擎名片')
  assert.ok(r.summary && r.summary.preflight, '结果里要带静态前置检查的汇总')
  const s = r.summary.preflight
  assert.strictEqual(s.total, 3)
  assert.ok(Number.isInteger(s.passed) && s.passed >= 0 && s.passed <= 3)
  assert.ok(['ok', 'fail', 'unknown'].includes(s.status))
  assert.strictEqual(r.summary.runtime, undefined,
    '真实合成的结论由界面按 A 级结果判定，静态接口不代报')
})

test('界面把两层结论分开呈现，B 级不计入运行验证通过', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'StepVerify.jsx'), 'utf8')
  assert.match(src, /t\('Verification overview', '校验结论'\)/)
  assert.match(src, /t\('Preflight checks', '接入前置检查'\)/)
  assert.match(src, /t\('Runtime synthesis', '运行验证'\)/)
  assert.match(src, /checks\.audio\.level === 'A'/, '只有 A 级才算真实合成')
  assert.match(src, /They do not prove that the engine can synthesise speech/,
    '静态全绿时必须说明不能证明能出声')
})
