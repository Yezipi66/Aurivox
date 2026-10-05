'use strict'
// ============================================================================
//  INSTANCES —— 「别人是怎么填的」对照数据
//
//  ⭐ 这个文件是纯**数据**：把三台已经在跑的引擎的名片，按字段摘出来，
//  让填名片的人有东西可对照。
//
//  为什么这样最省事
//  46 个键、60 条校验规则 —— 靠读文档全记住不可能。
//  但看一眼「同一字段别人怎么写」立刻就懂。参照实例是这个道理。
//
//  ⛔⛔ 纪律：算法代码里不许出现引擎名；**这里可以**，因为它就是数据源。
//  test/ 里有一条测试守着「算法侧仍然干净」。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ENGINES_DIR = path.join(REPO_ROOT, 'engines')

/** 逐字读引擎目录 —— ⛔ 不写引擎名，靠目录自己说话 */
function listEngineIds () {
  let names = []
  try {
    names = fs.readdirSync(ENGINES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  return names.filter((n) => !n.startsWith('_') && !n.startsWith('.'))
    .filter((n) => fs.existsSync(path.join(ENGINES_DIR, n, 'manifest.json')))
}

function readManifest (id) {
  const f = path.join(ENGINES_DIR, id, 'manifest.json')
  if (!fs.existsSync(f)) return null
  try {
    return JSON.parse(fs.readFileSync(f, 'utf-8'))
  } catch {
    return null
  }
}

/** 剥掉 _ 开头的注释键（它们是给人看的，不算字段） */
function withoutComments (obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue
    out[k] = v
  }
  return out
}

/**
 * 某一个键：各方都怎么填的。
 * @param {string} key  顶层键名
 * @returns {{key:string, samples:Array<{engine:string, value:any}>, presentIn:number, total:number}}
 */
function fieldSamples (key) {
  const ids = listEngineIds()
  const samples = []
  for (const id of ids) {
    const m = readManifest(id)
    if (!m) continue
    const c = withoutComments(m)
    if (c[key] === undefined) continue
    samples.push({ engine: id, value: c[key] })
  }
  return { key, samples, presentIn: samples.length, total: ids.length }
}

/**
 * 某一个参数名：各方在 parameters[] 里怎么写的。
 * @param {string} name  参数名
 * @returns {{name:string, samples:Array, presentIn:number, total:number}}
 */
function paramSamples (name) {
  const ids = listEngineIds()
  const samples = []
  for (const id of ids) {
    const m = readManifest(id)
    if (!m || !Array.isArray(m.parameters)) continue
    const hit = m.parameters.find((p) => p && p.name === name)
    if (hit) {
      const c = withoutComments(hit)
      // ⛔ 只留「用户真看得见」的键；_confidence/_why 这些是我们自己的注解
      samples.push({ engine: id, entry: c })
    }
  }
  return { name, samples, presentIn: samples.length, total: ids.length }
}

/** 全部参数的对照表（做「参数面板」那一屏用） */
function allParamNames () {
  const ids = listEngineIds()
  const seen = new Map()
  for (const id of ids) {
    const m = readManifest(id)
    if (!m || !Array.isArray(m.parameters)) continue
    for (const p of m.parameters) {
      if (!p || !p.name) continue
      if (!seen.has(p.name)) seen.set(p.name, [])
      seen.get(p.name).push(id)
    }
  }
  return [...seen.entries()]
    .map(([name, engines]) => ({ name, engines }))
    .sort((a, b) => b.engines.length - a.engines.length || a.name.localeCompare(b.name))
}

/**
 * 某一类参数的真实 tier 分布 —— 拿来看「别人把它放哪档」。
 * ⭐ 这是档位复核的**经验基线**：向导建议 common 之前，先看看别人怎么分。
 */
function tierDistribution (phase) {
  const want = phase || 'call'
  const dist = { common: 0, advanced: 0, unspecified: 0 }
  const perEngine = {}
  for (const id of listEngineIds()) {
    const m = readManifest(id)
    if (!m || !Array.isArray(m.parameters)) continue
    const rows = m.parameters.filter(
      (p) => p && (p.phase || 'call') === want)
    if (!rows.length) continue
    perEngine[id] = { common: 0, advanced: 0, unspecified: 0 }
    for (const p of rows) {
      // ⛔ 平台规则：没写 tier ⇒落进 advanced（web/src/lib/engines.js:164）
      const t = p.tier === 'common' ? 'common' : 'advanced'
      dist[t] += 1
      perEngine[id][t] += 1
      if (p.tier === undefined) dist.unspecified += 1
    }
  }
  return { phase: want, distribution: dist, perEngine }
}

module.exports = {
  listEngineIds,
  readManifest,
  withoutComments,
  fieldSamples,
  paramSamples,
  allParamNames,
  tierDistribution,
  ENGINES_DIR,
  REPO_ROOT,
}