#!/usr/bin/env node
'use strict'
// 「连不上引擎也要点名」这一刀的突变验证：逐处把改动改坏，确认有测试变红。
// GREEN = 那处改动没有任何测试盯着（或者突变本身写坏了 —— 先怀疑这个）。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 突变要往盘上写，而某些环境（比如助手的沙箱）源码目录是只读的。
// 一律先复制一份到临时目录里改 —— 顺带保证真正的工作区永远不会被留下脏文件，
// 哪怕脚本中途被 Ctrl-C 掐死。
const SRC = path.resolve(__dirname, '..', '..')
const root = process.env.MUTATE_IN_PLACE === '1'
  ? SRC
  : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mutate-'))
if (root !== SRC) {
  fs.cpSync(SRC, root, { recursive: true, dereference: false })
  console.log(`工作副本: ${root}\n`)
}
const F = {
  ue: path.join(root, 'lib/engines/upstreamError.js'),
  fd: path.join(root, 'lib/services/failureDetail.js'),
  svc: path.join(root, 'lib/services/synthesisService.js'),
  rt: path.join(root, 'lib/routes/synthesis.js'),
  srv: path.join(root, 'server.js'),
}
const TESTS = [
  'lib/engines/transportError.node.test.js',
  'lib/engines/upstreamError.node.test.js',
  'lib/services/synthesisService.errorDetail.node.test.js',
  'lib/services/synthesisService.nails.node.test.js',
  'lib/routes/synthesis.errorEngineName.node.test.js',
]

const MUT = [
  // ---- upstreamError.js：识别 ----
  ['ECONNREFUSED 从识别表里去掉', F.ue,
    "  ECONNREFUSED: 'the engine is not running (nothing is listening on that address)',",
    "  ECONNREFUSED_typo: 'the engine is not running (nothing is listening on that address)',"],
  ['自建超时（没有 code 那条）不再算传输层失败', F.ue,
    "  return err.message === 'Request timed out'",
    '  return false'],
  ['把上游 400 也误判成连不上', F.ue,
    '  if (!err) return false',
    '  if (!err) return false\n  if (err.upstreamStatus) return true'],

  // ---- upstreamError.js：消息 ----
  ['消息里不再点名引擎', F.ue,
    'const parts = [`Cannot reach ${engineName(profile)}`]',
    "const parts = ['Cannot reach the TTS engine']"],
  ['消息里不再带地址', F.ue,
    "  if (where) parts.push(`at ${where}`)",
    '  if (false) parts.push(`at ${where}`)'],
  ['消息里不再带错误码', F.ue,
    'const err = new Error(`${parts.join(\' \')} — ${tail}${code ? ` (${code})` : \'\'}`)',
    "const err = new Error(`${parts.join(' ')} — ${tail}`)"],
  ['不认识的码也硬套一句人话', F.ue,
    "  const tail = hint || (cause && cause.message) || 'the connection failed'",
    "  const tail = hint || 'the connection failed'"],

  // ---- upstreamError.js：承重字段 ----
  ['transport 标记不再挂上去', F.ue,
    '  err.transport = true', '  err.transport = undefined'],
  ['transportCode 不再挂上去', F.ue,
    '  err.transportCode = code || null', '  err.transportCode = null'],
  ['baseUrl 不再挂上去', F.ue,
    '  err.baseUrl = where || null', '  err.baseUrl = null'],
  ['名片为 null 时崩掉（不再回落通用称呼）', F.ue,
    '  err.engineId = (profile && profile.id) || null\n  err.engineLabel = engineName(profile)\n  err.baseUrl = where || null',
    '  err.engineId = profile.id\n  err.engineLabel = engineName(profile)\n  err.baseUrl = where || null'],

  // ---- failureDetail.js：⛔ 脱敏正则吃地址 ----
  ['⛔ 传输层早返回被删（地址会被脱敏正则吃掉）', F.fd,
    '  if (err && err.transport === true) {',
    '  if (false) {'],

  // ---- synthesisService.js：单段路径剥壳 ----
  ['单段路径的 try/catch 被摘掉（退回 Internal server error）', F.svc,
    'synthesisFailureDetail(', 'String('],

  // ---- server.js / routes：包装点 ----
  ['server.js 的 gsvPost 不再包传输层错误（退回裸 Node 错误）', F.srv,
    '    if (isTransportError(err)) {\n      throw transportFailure(_profile, err,\n        { baseUrl: (engine && engine.base_url) || _profile.base_url });\n    }\n    throw err;',
    '    throw err;'],
  ['server.js 点名了引擎但把地址丢了', F.srv,
    '        { baseUrl: (engine && engine.base_url) || _profile.base_url });',
    '        {});'],
  ['流式端点不再包传输层错误', F.rt,
    '            if (isTransportError(err)) {',
    '            if (false) {'],
  ['非流式端点不再包传输层错误', F.rt,
    '          if (isTransportError(err)) {',
    '          if (false) {'],
]

let red = 0; let green = 0; let bad = 0
for (const [name, file, from, to] of MUT) {
  const orig = fs.readFileSync(file, 'utf8')
  if (!orig.includes(from)) { console.log(`⚠ 锚点没对上（突变本身写坏了）: ${name}`); bad++; continue }
  fs.writeFileSync(file, orig.replace(from, to))
  const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: root, encoding: 'utf8' })
  fs.writeFileSync(file, orig)
  const failed = r.status !== 0
  console.log(`${failed ? '✔ RED ' : '✖ GREEN'}  ${name}`)
  if (failed) red++; else green++
}
console.log(`\nRED ${red} / GREEN ${green} / 锚点坏 ${bad} / 共 ${MUT.length}`)
process.exit(green + bad === 0 ? 0 : 1)
