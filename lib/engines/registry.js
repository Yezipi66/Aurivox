'use strict'

// ---------------------------------------------------------------------------
//  Engine registry — 扫 engines/*/manifest.json，不写死任何引擎名
// ---------------------------------------------------------------------------
// 这个文件存在的唯一理由，是让「加一个引擎」不需要改 lib/ 下任何代码：
//
//   加引擎 = 新建 engines/<id>/manifest.json  （+ 引擎自己的代码）
//
// 所以本文件里**不允许出现任何具体引擎的名字**。lib/engines/registry.node.test.js
// 有一条守卫盯着这件事 —— 一旦有人为了图快在这里写个 if (id === 'xxx')，
// 测试会红。
//
// 目录即注册：engines/ 下每一个带 manifest.json 的目录就是一个引擎。没有
// 中心清单文件要维护，也就不会出现「目录建了但忘了登记」这种半生效状态。

const fs = require('node:fs')
const path = require('node:path')
const { ENGINES_DIR } = require('../paths')

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
    // 坏掉的 manifest 必须响，不能当作「这个引擎不存在」悄悄跳过 ——
    // 那会让一个 JSON 语法错误表现为「引擎莫名其妙消失了」。
    throw registryError('ENGINE_MANIFEST_INVALID',
      `引擎清单无法解析：${file}（${err.message}）`, { id, file })
  }
  const manifest = stripComments(parsed)
  if (manifest.id && manifest.id !== id) {
    throw registryError('ENGINE_MANIFEST_ID_MISMATCH',
      `引擎清单里的 id 是 "${manifest.id}"，但它所在的目录叫 "${id}" —— ` +
      '两者必须一致，否则按目录找和按 id 找会得到不同答案',
      { id, declared: manifest.id, file })
  }
  manifest.id = id
  manifest.dir = dir
  if (!Array.isArray(manifest.param_keys)) manifest.param_keys = []
  return manifest
}

// 每次调用重新扫盘。引擎数是个位数，扫一次是微秒级；换来的是「新建目录后
// 不用重启就能被看见」，以及测试之间不会因为缓存互相污染。
function listEngines() {
  let entries
  try {
    entries = fs.readdirSync(ENGINES_DIR, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // _ 开头的是模板/脚手架，不是可用引擎。
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const manifest = readManifest(path.join(ENGINES_DIR, entry.name), entry.name)
    if (manifest) found.push(manifest)
  }
  found.sort((a, b) => a.id.localeCompare(b.id))
  return found
}

function listEngineIds() {
  return listEngines().map((m) => m.id)
}

function getEngine(id) {
  if (!id) return null
  return listEngines().find((m) => m.id === id) || null
}

// 拿不到就抛，且错误里带上「这台机器上到底装了哪些」—— 光说
// "unsupported engine" 而不说有哪些可用，排查时还得再问一次。
function requireEngine(id) {
  const manifest = getEngine(id)
  if (manifest) return manifest
  const available = listEngineIds()
  throw registryError('FG_ENGINE_UNSUPPORTED',
    available.length
      ? `这台服务器上没有装引擎 ${id}；已装的是：${available.join('、')}`
      : `这台服务器上没有装任何引擎（${ENGINES_DIR} 下找不到 manifest.json），图里要的是 ${id}`,
    { engine_id: id, available })
}

module.exports = {
  listEngines,
  listEngineIds,
  getEngine,
  requireEngine,
}
