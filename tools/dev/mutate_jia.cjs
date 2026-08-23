#!/usr/bin/env node
'use strict'
// 甲的突变验证：逐处把改动"改坏"，确认有测试变红。
// GREEN = 那处改动没有任何测试盯着（或者突变本身写坏了）。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..', '..')
const F = {
  ue: path.join(root, 'lib/engines/upstreamError.js'),
  svc: path.join(root, 'lib/services/synthesisService.js'),
  rt: path.join(root, 'lib/routes/synthesis.js'),
  srv: path.join(root, 'server.js'),
}
const TESTS = [
  'lib/engines/upstreamError.node.test.js',
  'lib/services/synthesisService.errorDetail.node.test.js',
  'lib/services/synthesisService.nails.node.test.js',
  'lib/routes/synthesis.errorEngineName.node.test.js',
  'lib/routes/synthesis.enginePayload.node.test.js',
]

const MUT = [
  ['名字写死回 GPT-SoVITS', F.ue,
    "return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'TTS engine'",
    "return 'GPT-SoVITS'"],
  ['label 回落到 id 被摘掉', F.ue,
    'const raw = profile && (profile.label || profile.id)',
    'const raw = profile && profile.label'],
  ['空白 label 也当名字用', F.ue,
    "return (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'TTS engine'",
    "return (typeof raw === 'string') ? raw : 'TTS engine'"],
  ['upstreamBody 不再挂上去', F.ue,
    'err.upstreamBody = text', 'err.upstreamBody = undefined'],
  ['upstreamStatus 不再挂上去', F.ue,
    'err.upstreamStatus = Number(statusCode)', 'err.upstreamStatus = undefined'],
  ['engineId 不再挂上去', F.ue,
    "err.engineId = (profile && profile.id) || null\n  err.engineLabel = engineName(profile)\n  return err\n}\n\n/**\n * 上游返回 200",
    "err.engineId = null\n  err.engineLabel = engineName(profile)\n  return err\n}\n\n/**\n * 上游返回 200"],
  ['流式与非流式文案不再区分', F.ue,
    "const what = opts.streaming ? STREAMING_FAILED : FAILED", 'const what = FAILED'],
  ['Buffer 正文不转字符串', F.ue,
    "const text = body === undefined || body === null ? '' : String(body)",
    "const text = body === undefined || body === null ? '' : body"],
  ['空正文写成 "undefined" 字样', F.ue,
    "const text = body === undefined || body === null ? '' : String(body)",
    'const text = String(body)'],
  ['空音频那条编一个空正文出来', F.ue,
    "const err = new Error(`${engineName(profile)} returned empty audio`)",
    "const err = new Error(`${engineName(profile)} returned empty audio`)\n  err.upstreamBody = ''"],
  ['结构化剥壳整条摘掉（回到只有正则）', F.svc,
    'if (err && typeof err.upstreamBody === "string" && err.upstreamBody !== "") {\n    message = unwrapUpstreamBody(err.upstreamBody);\n  } else {',
    'if (false) {\n  } else {'],
  ['兜底正则被删（只信结构化字段）', F.svc,
    'const upstream = message.match(/GPT-SoVITS \\/tts failed \\(\\d+\\):\\s*([\\s\\S]*)$/);\n    if (upstream) message = unwrapUpstreamBody(upstream[1]);',
    ''],
  ['JSON 里的 detail 不再被提出来', F.svc,
    'return String(parsed.detail || parsed.message || parsed.error || raw);',
    'return raw;'],
  ['绝对路径不再抹成 [path]', F.svc,
    'message = message.replace(/[A-Za-z]:[\\\\/][^\\s"\']+|\\/(?:[^\\s"\']+\\/){2,}[^\\s"\']+/g, "[path]");',
    ''],
  ['非流式路由改回写死的名字', F.rt,
    'throw new HttpError(502, upstreamFailure(nProfile, ttsRes.statusCode, ttsRes.body.toString()).message);',
    'throw new HttpError(502, `GPT-SoVITS /tts failed (${ttsRes.statusCode}): ${ttsRes.body.toString()}`);'],
  ['流式路由改回写死的名字', F.rt,
    'throw new HttpError(502,\n              upstreamFailure(sProfile, up.statusCode, body.slice(0, 500), { streaming: true }).message);',
    'throw new HttpError(502, `GPT-SoVITS /tts streaming failed (${up.statusCode}): ${body.slice(0, 500)}`);'],
  ['空音频路由改回写死的名字', F.rt,
    'if (!wavBytes || wavBytes.length === 0) throw new HttpError(502, emptyAudioFailure(nProfile).message);',
    'if (!wavBytes || wavBytes.length === 0) throw new HttpError(502, "GPT-SoVITS returned empty audio");'],
  ['流式路由点名点错引擎（拿老路径那台顶包）', F.rt,
    'upstreamFailure(sProfile, up.statusCode, body.slice(0, 500), { streaming: true })',
    'upstreamFailure(resolveEngineProfile(findLegacyDefaultId()), up.statusCode, body.slice(0, 500), { streaming: true })'],
  ['server.js 改回写死的名字', F.srv,
    'throw upstreamFailure(_profile, ttsRes.statusCode, ttsRes.body.toString());',
    'throw new Error(`GPT-SoVITS /tts failed (${ttsRes.statusCode}): ${ttsRes.body.toString()}`);'],
  ['server.js 空音频改回写死的名字', F.srv,
    'throw emptyAudioFailure(_profile);',
    'throw new Error("GPT-SoVITS returned empty audio");'],
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
