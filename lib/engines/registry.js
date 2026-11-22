'use strict'

//  Engine registry — 扫 engines/*/manifest.json，不写死任何引擎名
// 这个文件存在的唯一理由，是让「加一个引擎」不需要改 lib/ 下任何代码：
//
//   加引擎 = 新建 engines/<id>/manifest.json  （+ 引擎自己的代码）
//
// 所以本文件里不允许出现任何具体引擎的名字。lib/engines/registry.node.test.js
// 有一条守卫盯着这件事：一旦有人为了图快在这里写个 if (id === 'xxx')，
// 测试会红。
//
// 目录即注册：engines/ 下每一个带 manifest.json 的目录就是一个引擎。没有
// 中心清单文件要维护，也就不会出现「目录建了但忘了登记」这种半生效状态。

const fs = require('node:fs')
const path = require('node:path')
const { ENGINES_DIR } = require('../paths')
const { deriveParameterViews } = require('./parameterDeclaration')
const { fromV011 } = require('./contract')

function registryError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// manifest 里以 _ 开头的键是给人看的注释，不进运行时对象。
function stripComments(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out
}

function readManifest(dir, id) {
  const file = path.join(dir, 'manifest.json')
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    // 坏掉的 manifest 必须响，不能当作「这个引擎不存在」悄悄跳过，
    // 那会让一个 JSON 语法错误表现为「引擎莫名其妙消失了」。
    throw registryError('ENGINE_MANIFEST_INVALID',
      `引擎清单无法解析：${file}（${err.message}）`, { id, file })
  }
  let manifest = stripComments(parsed)
  // v0.1.1：磁盘三节是唯一真相，读盘时投影成老扁平视图。投影是每次读现算的，
  // 不写回磁盘，所以不会出现「两个字段各自漂移」。
  manifest = fromV011(manifest)
  manifest = deriveParameterViews(manifest)
  if (manifest.id && manifest.id !== id) {
    throw registryError('ENGINE_MANIFEST_ID_MISMATCH',
      `引擎清单里的 id 是 "${manifest.id}"，但它所在的目录叫 "${id}"：` +
      '两者必须一致，否则按目录找和按 id 找会得到不同答案',
      { id, declared: manifest.id, file })
  }
  manifest.id = id
  manifest.dir = dir
  if (!Array.isArray(manifest.param_keys)) manifest.param_keys = []
  return manifest
}

// 附加的引擎目录：真 engines/ 之外还要看的地方。
//   用途：测试要「多台引擎」时，可以指一个装着夹具的目录，
//   而不必把真名片搬走（搬走了名片的相对路径会解到别处去）。
//   由 AURIVOX_EXTRA_ENGINES_DIR 给出（多个用路径分隔符隔开）。
const EXTRA_ENGINES_DIRS = (process.env.AURIVOX_EXTRA_ENGINES_DIR || '')
  .split(path.delimiter)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => path.resolve(s))

// 每次调用重新扫盘。引擎数是个位数，扫一次是微秒级；换来的是「新建目录后
// 不用重启就能被看见」，以及测试之间不会因为缓存互相污染。
// opts.enginesDir：调用方已经知道引擎在哪个 engines/ 目录（向导在 worktree 里跑、
//   引擎只装在主仓库时就是这样），先扫它，同名以它为准；不给时行为不变。
function scanEngines(opts = {}) {
  const found = []
  const broken = []
  const seen = new Set()
  // 先扫真目录，再扫附加目录：同名时真目录那份算数（它是用户真装着的）。
  const dirs = [opts && opts.enginesDir, ENGINES_DIR, ...EXTRA_ENGINES_DIRS].filter(Boolean)
  for (const dir of dirs) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // _ 开头的是模板/脚手架，不是可用引擎。
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
      if (seen.has(entry.name)) continue
      let manifest
      try {
        manifest = readManifest(path.join(dir, entry.name), entry.name)
      } catch (err) {
        // 单台坏掉只登记这一台，列表继续往下扫。
        //   「坏名片必须响」不等于「整个列表陪葬」：一张名片的 id 写错，
        //   不该让同一个引擎目录里的其它引擎全都读不出来。响给谁由调用方决定，
        //   requireEngine 只在「你要的正是这一台」时才把它抛出来。
        broken.push({
          id: entry.name,
          dir: path.join(dir, entry.name),
          code: err.code || 'ENGINE_MANIFEST_INVALID',
          message: err.message,
        })
        continue
      }
      if (!manifest) continue
      seen.add(entry.name)
      found.push(manifest)
    }
  }
  found.sort((a, b) => a.id.localeCompare(b.id))
  return { engines: found, broken }
}

// 只用「能读的那几台」。坏的那台去哪儿了，由 scanEngines 的 broken 说清楚：
// 调用方要展示就能展示，不展示也不会因为一台坏名片而拿不到任何引擎。
function listEngines(opts = {}) {
  return scanEngines(opts).engines
}

function listEngineIds(opts = {}) {
  return listEngines(opts).map((m) => m.id)
}

function getEngine(id, opts = {}) {
  if (!id) return null
  return listEngines(opts).find((m) => m.id === id) || null
}

// 拿不到就抛，且错误里带上「本机上到底装了哪些」：光说
// "unsupported engine" 而不说有哪些可用，排查时还得再问一次。
// 你要的那台正好是坏的，报它自己的原因：否则会得到一句「没有装这台」，
// 而它就在盘上，只是名片写错了。
function requireEngine(id, opts = {}) {
  const { engines, broken } = scanEngines(opts)
  const manifest = engines.find((m) => m.id === id)
  if (manifest) return manifest
  const bad = broken.find((b) => b.id === id)
  if (bad) {
    throw registryError('ENGINE_MANIFEST_BROKEN', bad.message,
      { engine_id: id, dir: bad.dir, cause: bad.code })
  }
  const available = engines.map((m) => m.id)
  throw registryError('FG_ENGINE_UNSUPPORTED',
    available.length
      ? `这台服务器上没有装引擎 ${id}；已装的是：${available.join('、')}`
      : `这台服务器上没有装任何引擎（${ENGINES_DIR} 下找不到 manifest.json），图里要的是 ${id}`,
    { engine_id: id, available })
}

module.exports = {
  scanEngines,
  listEngines,
  listEngineIds,
  getEngine,
  requireEngine,
}
