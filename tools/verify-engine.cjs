#!/usr/bin/env node
'use strict'

// 第三道校验的 CLI：node tools/verify-engine.cjs --engine <id> [--level A|B]
//
// ⭐ 默认 B 级。A 级要真跑一次合成（要模型、要显存、慢）——
//   那不是一个可以随手敲一下的默认值。

const path = require('node:path')
const fs = require('node:fs')
const ROOT = path.join(__dirname, '..')
const { verifyEngine, buildSpec } = require(path.join(ROOT, 'lib/engines/verifyAudio.js'))

function arg(k) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null }
function has(k) { return process.argv.includes(k) }

const engineId = arg('--engine')
const level = (arg('--level') || 'B').toUpperCase()
const asJson = has('--json')

if (!engineId) {
  process.stdout.write(
    '第三道校验「出得了声」\n\n' +
    '用法：\n' +
    '  node tools/verify-engine.cjs --engine <id> [--level A|B] [--json]\n\n' +
    '  B 级（默认）宿主拿到合法响应。快，不吃显存，不出声。\n' +
    '        ⛔ 验不到「声音对不对」—— 只验到「宿主与引擎谈得拢」。\n' +
    '  A 级              真跑一次合成，要模型要显存（IndexTTS2 实测 import 34s）。\n' +
    '        需要 A 级时给一份请求体：--request <json文件>\n\n' +
    '⚠ 前两道校验用 node tools/dev/check-engine-env.cjs --engine <id> [--deep]\n')
  process.exit(1)
}

const { resolveEngineProfile } = require(path.join(ROOT, 'lib/engines/profile.js'))
const { requireEngine } = require(path.join(ROOT, 'lib/engines/registry.js'))

let profile, manifest
try {
  profile = resolveEngineProfile(engineId, process.env)
  manifest = requireEngine(engineId)
} catch (err) {
  process.stderr.write(`读不到引擎 ${engineId}：${(err && err.message) || err}\n`)
  process.exit(1)
}

// ⭐ 名片没写 runtime = 平台不负责起它 ⇒ 第三道无从谈起
if (!profile.runtime) {
  process.stderr.write(
    `引擎 ${engineId} 的 manifest.json 没有 runtime 段 —— 平台不负责起它，\n` +
    '也就无从替它验「出不出得了声」。那一道要由起它的人自己做。\n')
  process.exit(1)
}

let request = null
if (level === 'A') {
  const reqFile = arg('--request')
  if (reqFile && fs.existsSync(reqFile)) {
    request = JSON.parse(fs.readFileSync(reqFile, 'utf8'))
  }
  if (!request) {
    process.stderr.write(
      'A 级要真的合成。请给一份请求体：\n' +
      '  node tools/verify-engine.cjs --engine ' + engineId + ' --level A --request req.json\n\n' +
      'req.json 长这样（键名是**引擎方言**，照 engines/' + engineId + '/manifest.json 的 maps 写）：\n' +
      JSON.stringify({ text: '你好', ref_audio_path: '<一段真实参考音频的路径>' }, null, 2) + '\n')
    process.exit(1)
  }
}

if (!asJson) {
  process.stdout.write(`第三道校验「出得了声」 · ${engineId} · ${level} 级\n`)
  process.stdout.write(`  ${level === 'A' ? '⚠ 会真的跑一次合成（要模型、要显存、可能很慢）' : '快，不出声，不吃显存'}\n\n`)
}

const result = verifyEngine({ profile, manifest, level, request, root: ROOT })

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} else {
  printHuman(result)
}
process.exit(result.ok ? 0 : 1)

function printHuman(r) {
  if (r.ok) {
    process.stdout.write(`✅ ${r.level} 级通过（${r.engine}）\n`)
    for (const s of r.steps || []) {
      process.stdout.write(`   · ${s.step}${s.ok ? ' ✓' : ' ✗'}` +
        `${s.call_kind ? ` [${s.call_kind}${s.resident === false ? ' / 不常驻' : ''}]` : ''}` +
        `${s.message ? ` — ${s.message}` : ''}\n`)
    }
    if (r.wav) {
      process.stdout.write(`   · 音频 ${r.wav.duration_sec}s / ${r.wav.sample_rate}Hz / ` +
        `${r.wav.channels}ch / ${(r.wav.wav_bytes / 1024).toFixed(1)}KB\n`)
    }
    if (r.note) process.stdout.write(`   ℹ ${r.note}\n`)
  } else {
    process.stdout.write(`⛔ ${r.level || '?'} 级没过（${r.engine || engineId}）\n`)
    process.stdout.write(`   阶段：${r.stage || '?'}\n`)
    process.stdout.write(`   原因：${r.error || '?'}\n`)
    if (r.wav) process.stdout.write(`   音频体检：${JSON.stringify(r.wav)}\n`)
    if (r.why) process.stdout.write(`   为什么这要紧：${r.why}\n`)
    if (r.detail) process.stdout.write(`   详情：\n${String(r.detail).split('\n').map(l => '     ' + l).join('\n').slice(0, 2000)}\n`)
  }
}
