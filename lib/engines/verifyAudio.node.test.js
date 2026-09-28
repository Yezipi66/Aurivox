'use strict'
// ============================================================================
//  第三道校验的守卫【C1】
//
//  ⚠ 这一份只测**纯函数那一层**（buildSpec）。真发 HTTP 的判别力在
//     tools/dev/probe_verify_audio.py —— 那要起服务 + spawn python，
//     塞进 npm test 会给 1700 条测试加两条慢的、还依赖 python 在 PATH 上。
//     ⭐ 两半都必须有：纯函数测「规格拼对没有」，实测脚本测「判得准不准」。
// ============================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { buildSpec, VERIFIER } = require('./verifyAudio.js')

const PROF = {
  id: 'demo', label: 'Demo', base_url: 'http://127.0.0.1:9881/',
  timeout_ms: 180000, runtime: { ready_timeout_ms: 180000 },
}

// ---------------------------------------------------------------------------
//  1) ⭐⭐ 两级的语义
// ---------------------------------------------------------------------------

test('⭐⭐⭐ 默认是 B 级 —— ⛔ A 级要模型要显存，不该是随手一敲的默认值', () => {
  const s = buildSpec({ profile: PROF })
  assert.equal(s.level, 'B')
  assert.equal(s.request, undefined, 'B 级不组请求体')
})

test('⭐⭐ A 级必须显式要，且必须给 text —— 拿什么合成？', () => {
  assert.throws(() => buildSpec({ profile: PROF, level: 'A' }),
    (err) => err.code === 'ENGINE_VERIFY_A_NEEDS_TEXT',
    '⛔ A 级没有 text 就该当场拒绝，而不是发一个空请求去问引擎')
  const s = buildSpec({ profile: PROF, level: 'A', request: { text: '你好' } })
  assert.equal(s.level, 'A')
  assert.equal(s.request.text, '你好')
})

test('⭐⭐ level 写别的 ⇒ 当场报错（⛔ 不许悄悄降级成 B）', () => {
  // ⭐ 降级是最坏的一种失败：用户以为验了 A 级，实际只验了 B 级。
  for (const bad of ['C', '', '  ', 'yes', 0, 1]) {
    assert.throws(() => buildSpec({ profile: PROF, level: bad, request: { text: 'x' } }),
      (err) => err.code === 'ENGINE_VERIFY_LEVEL_INVALID',
      `level="${bad}" 应当被拒`)
  }
})

test('⭐⭐ level 大小写 + 空白都认（a / A / " a " 都行）', () => {
  assert.equal(buildSpec({ profile: PROF, level: 'a', request: { text: 'x' } }).level, 'A')
  assert.equal(buildSpec({ profile: PROF, level: 'A', request: { text: 'x' } }).level, 'A')
  assert.equal(buildSpec({ profile: PROF, level: ' a ', request: { text: 'x' } }).level, 'A')
  assert.equal(buildSpec({ profile: PROF, level: 'B' }).level, 'B')
})

test('⭐⭐⭐ 「没给」用默认 B，但「给了空」当场拒 —— ⛔ 不许静默降级', () => {
  // ⭐ 变异/实测抓出来的洞：`opts.level || 'B'` 会把 '' 和 '  ' 都吞成 B。
  //   那是「--level 后面漏了值」或「读了空环境变量」时的表现。
  //   后果：用户以为跑了一次校验，实际跑的是**弱得多**的那一档，
  //   而且**没有任何提示**。静默降级长得像「验过了」。
  for (const empty of ['', '   ']) {
    assert.throws(() => buildSpec({ profile: PROF, level: empty, request: { text: 'x' } }),
      (err) => err.code === 'ENGINE_VERIFY_LEVEL_INVALID',
      `level=${JSON.stringify(empty)} 应当被拒，而不是悄悄变成 B`)
  }
  // 真的没给（undefined / null）才走默认
  assert.equal(buildSpec({ profile: PROF, level: undefined }).level, 'B')
  assert.equal(buildSpec({ profile: PROF, level: null }).level, 'B')
  assert.equal(buildSpec({ profile: PROF }).level, 'B')
})

// ---------------------------------------------------------------------------
//  2) ⭐⭐⭐ B 级那一发「故意缺 text」的请求体
// ---------------------------------------------------------------------------

test('⭐⭐⭐ B 级复用 A 级的请求体去掉 text —— ⛔ 不另编一个', () => {
  // ⭐ 另编一个就多一处「两份不一样」的可能，而那种不一致不报错。
  const req = { text: '你好', ref_audio_path: 'a.wav', emo_alpha: 0.5 }
  const s = buildSpec({ profile: PROF, level: 'A', request: req })
  assert.equal('text' in s.minimal_request, false, '⛔ text 必须被去掉')
  assert.equal(s.minimal_request.ref_audio_path, 'a.wav', '其余照原样')
  assert.equal(s.minimal_request.emo_alpha, 0.5)
  // ⛔ 而且不许改动原请求体
  assert.equal(req.text, '你好', '⛔ buildSpec 改了调用方的对象')
})

test('⭐⭐⭐ 两次调用不许互相污染（minimal_request 必须是新对象）', () => {
  const req = { text: 'x' }
  const a = buildSpec({ profile: PROF, level: 'A', request: req })
  const b = buildSpec({ profile: PROF, level: 'A', request: req })
  assert.notEqual(a.minimal_request, b.minimal_request, '⛔ 共用同一个对象 = 改一个影响另一个')
  a.minimal_request.injected = true
  assert.equal('injected' in b.minimal_request, false)
})

// ---------------------------------------------------------------------------
//  3) ⭐⭐ 超时预算
// ---------------------------------------------------------------------------

test('⭐⭐ 超时跟着名片的 timeout_ms 走，不写死', () => {
  const s = buildSpec({ profile: { ...PROF, timeout_ms: 300000 } })
  assert.equal(s.ready_timeout, 300, 'IndexTTS2 实测 import 34s，写死 30 会误杀')
  assert.equal(s.synth_timeout, 300)
})

test('⭐⭐ 名片没写 timeout_ms ⇒ 用一个不会误杀的下限', () => {
  const s = buildSpec({ profile: { id: 'x', base_url: 'http://127.0.0.1:1' } })
  assert.ok(s.ready_timeout >= 30, '⛔ 太小的超时会把「慢」误判成「坏」')
  assert.ok(s.synth_timeout >= 60)
})

// ---------------------------------------------------------------------------
//  4) ⭐⭐⭐ 诚实性：这一层不许自己动手
// ---------------------------------------------------------------------------

test('⭐⭐⭐ verifyAudio.js 不许 spawn 引擎、不许 import 上游', () => {
  const src = fs.readFileSync(path.join(__dirname, 'verifyAudio.js'), 'utf8')
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // ⛔ 它只该 spawn **探针**（自己的 python），不该碰引擎的解释器
  for (const forbidden of ['.venv', 'engines/', 'importlib', 'infer_v2', 'IndexTTS']) {
    assert.equal(code.includes(forbidden), false,
      `⛔ verifyAudio 出现了 ${forbidden} —— 探针只做 HTTP+WAV，不 import 引擎的任何东西`)
  }
})

test('⭐⭐⭐ 探针不许 import 名片没点名的东西（与 env_probe 同纪律）', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  const code = src.replace(/#.*$/gm, '').replace(/\u0022{3}[\s\S]*?\u0022{3}/g, '')
  // ⛔ torch / numpy / 引擎的包 —— 那会把平台的假设塞进本该由名片说了算的地方
  for (const forbidden of ['import torch', 'import numpy', 'import indextts', 'import soundfile']) {
    assert.equal(code.includes(forbidden), false, `⛔ 探针 import 了 ${forbidden}`)
  }
})

test('⭐⭐ 探针只用 stdlib（多一个依赖就多一处「装没装」的变量）', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  const imports = [...src.matchAll(/^\s*(?:from|import)\s+([a-zA-Z_][\w.]*)/gm)].map(m => m[1])
  const allowed = new Set(['io','json','os','struct','sys','threading','traceback','wave',
    '__future__','urllib','urllib.request','urllib.error','base64'])
  for (const i of imports) {
    assert.ok(allowed.has(i), `⛔ 探针 import 了非 stdlib 的 ${i} —— stdlib urllib + wave 够用`)
  }
})

test('⭐⭐⭐ WAV 体检必须看「有没有帧」，⛔ 不能只看长度', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  assert.match(src, /frames <= 0|一帧都没有/,
    '⭐ 44 字节的空 WAV 是最阴的失败：文件合法、能播、0 秒、界面上看不出异常')
  assert.match(src, /sample_rate|采样率/,
    '⭐ 采样率是 0 或荒诞值要抓 —— 那种能播，但拼不上（见 host.py _wav_meta）')
})

test('⭐⭐ 探针永远以 0 退出（「验不过」是答案不是探针出错）', () => {
  const src = fs.readFileSync(VERIFIER, 'utf8')
  assert.match(src, /return 0\s+#?\s*⭐?\*?⭐?.*永远/,
    '⭐ 与 env_probe.py 同纪律：非零码必须只表示「探针自己崩了」')
})

// ---------------------------------------------------------------------------
//  5) ⭐⭐ 名片没有 runtime ⇒ 无从谈起（CLI 那一层的判据）
// ---------------------------------------------------------------------------

test('⭐⭐ buildSpec 只需要 base_url / timeout —— ⛔ 不该要求 runtime', () => {
  // runtime 那一层的检查在 CLI（因为要说「平台不负责起它」那句话）。
  // ⭐ 这里再要求一次 = 同一件事判两遍，两遍迟早说法不一样。
  const s = buildSpec({ profile: { id: 'x', base_url: 'http://127.0.0.1:1' } })
  assert.equal(s.base_url, 'http://127.0.0.1:1')
})
