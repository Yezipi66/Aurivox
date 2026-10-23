#!/usr/bin/env node
'use strict'

// 平台根 venv 的隔离守卫。
// 平台根 venv/ 只装平台自己的东西，不含 torch / CUDA /
// librosa；引擎与训练线的重依赖住 engines/<id>/.venv 各自的环境里。
// 这条守卫只看「装了什么」，不看「为什么」：理由会漂移，装了什么不会。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// 项目根不按 __dirname 数目录层数拿：数错一层会让下面两条守卫静默 skip，
// 而「静默 skip」是守卫最坏的失败模式。从这里向上找 server.js，它所在的目录就是项目根
// （锚点约定见 docs/ROOT_LAYOUT.md）。
function detectRoot () {
  let dir = __dirname
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'server.js'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error(
    `向上找不到 server.js（从 ${__dirname} 起 6 级）—— 无法定位项目根。`
    + '⛔ 这不是「跳过这条守卫」的理由，是这个文件放错了位置。')
}

const ROOT = detectRoot()

test('⭐ 这条守卫自己先证明它找对了项目根（否则后面两条会静默 skip）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'server.js')),
    `项目根 ${ROOT} 下没有 server.js`)
  assert.ok(fs.existsSync(path.join(ROOT, 'package.json')))
  assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'engines', 'envCheck.js')),
    '项目根下没有 lib/engines/ —— 说明 ROOT 算错了')
})

const ROOT_VENV = path.join(ROOT, 'venv')
const SITE = path.join(ROOT_VENV, 'Lib', 'site-packages')
const SITE_POSIX = path.join(ROOT_VENV, 'lib', 'python3', 'site-packages')

function sitePackagesDir () {
  if (fs.existsSync(SITE)) return SITE
  if (fs.existsSync(SITE_POSIX)) return SITE_POSIX
  return null
}

// 绝不许出现在平台根 venv 里的包。每一条都注明为什么：
// 「因为它属于某台引擎」这种理由会过期，而「它属于 GSV 的推理运行时」不会。
const FORBIDDEN = [
  ['torch', 'GSV 推理运行时（C12：每台引擎住 engines/<id>/.venv）'],
  ['torchaudio', 'GSV 推理运行时'],
  ['torchvision', 'GSV 推理运行时'],
  ['librosa', '训练线的音频加载；根 venv 曾为它背上整套 soundfile 系'],
  ['soundfile', '训练线的音频加载'],
  ['fastapi', '⭐ 只被 GSV 专有的 lib/inference/infer_server.py 用（E3 那笔账：它该搬进 engines/gpt-sovits/）'],
  ['uvicorn', '⭐ 同上 —— 它服务的是 GSV 的老宿主，不是平台的 HTTP 面'],
  ['pydantic', '⚠ 边界项：infer_server.py 的 TTS_Request 要它。**若这一条先红了，先确认是不是 E3 已落地** —— 落地之后 pydantic 就该只存在于 engines/gpt-sovits/.venv'],
  ['onnxruntime', 'ASR 线（G2PW）与训练线共用，不是平台的'],
  ['onnxruntime_gpu', '同上'],
]

test('⛔ 平台根 venv 里不许出现引擎/训练线的重依赖（C12 不变式 1）', (t) => {
  const dir = sitePackagesDir()
  if (!dir) {
    //  干净克隆上根本没有 venv ： 那正是目标状态，不是失败。
    t.skip(`平台根 venv 还没建（${ROOT_VENV} 不存在）—— 干净克隆上正是 C12 想要的样子`)
    return
  }
  const present = new Set(fs.readdirSync(dir).map((x) => x.toLowerCase()))
  const bad = []
  for (const [name, why] of FORBIDDEN) {
    //  要同时看 dist-info 与裸模块目录：pip 装的会留前者，
    //  而某些包装器只留后者：只看一种会让这条守卫形同虚设。
    const hit = present.has(name) ||
      [...present].some((p) => p.startsWith(name + '-') && p.endsWith('.dist-info'))
    if (hit) bad.push(`${name} —— ${why}`)
  }
  assert.deepStrictEqual(bad, [],
    `根 venv 里装了 ${bad.length} 个不属于平台的东西：\n  - ${bad.join('\n  - ')}\n` +
    `  C12 不变式 1：根 venv 只装平台自己的。\n` +
    '  ⚠️ 如果你确实需要它装在根 venv，那要改的是 C12 不变式 1 本身，'
    + '⛔ 不是把这条断言放宽。')
})

test('⭐ 根 venv 若存在，装的东西应当少得可疑（体量守卫）', (t) => {
  const dir = sitePackagesDir()
  if (!dir) { t.skip('平台根 venv 还没建（干净克隆）'); return }
  const entries = fs.readdirSync(dir)
  //  只数带版本信息的（dist-info/egg-info）；裸模块目录不带版本。
  const withVersion = entries.filter((e) => /\.(dist-info|egg-info)$/.test(e))
  assert.ok(withVersion.length <= 40,
    `根 venv 里有 ${withVersion.length} 个带版本的包 —— 平台自己只需要 3 个`
    + '（uv / packaging / hf_transfer，见 requirements-platform.txt）。\n'
    + '  ⚠️ 实测那次违规是 206 个 / 7.0 GB，而它「看起来一直很正常」。')
})
