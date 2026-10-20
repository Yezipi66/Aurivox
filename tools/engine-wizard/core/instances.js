'use strict'
//  INSTANCES：按字段摘出各引擎名片的对照数据，供填名片的人参考

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
// 引擎目录有两处：真 engines/ 与附加目录。
//   附加目录由 AURIVOX_EXTRA_ENGINES_DIR 给出（路径分隔符隔开多个），
//   与 lib/engines/registry.js 是同一套覆盖口。
//   为什么需要它：干净检出（CI）里 engines/ 只有一张真名片，
//   而「拿多台引擎的样本当基线」那几组测试需要更多台。
const ENGINE_DIRS = [
  path.join(REPO_ROOT, 'engines'),
  ...(process.env.AURIVOX_EXTRA_ENGINES_DIR || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s)),
]

/** 逐字读引擎目录：不写引擎名，靠目录自己说话 */
function listEngineIds () {
  let names = []
  for (const dir of ENGINE_DIRS) {
    try {
      names = names.concat(fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name))
    } catch {
      // 这个目录没有 ⇒ 跳过（真 engines/ 在别的机器上可能不存在）
    }
  }
  const seen = new Set()
  return names
    .filter((n) => !n.startsWith('_') && !n.startsWith('.'))
    .filter((n) => !seen.has(n) && seen.add(n))
    .filter((n) => ENGINE_DIRS.some((dir) =>
      fs.existsSync(path.join(dir, n, 'manifest.json'))))
}

/** 读一张名片：先在真目录找，找不到再在附加目录里找 */
function readManifest (id) {
  for (const dir of ENGINE_DIRS) {
    const f = path.join(dir, id, 'manifest.json')
    if (!fs.existsSync(f)) continue
    try {
      return JSON.parse(fs.readFileSync(f, 'utf-8'))
    } catch {
      return null
    }
  }
  return null
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
      // 只留「用户真看得见」的键；_confidence/_why 这些是我们自己的注解
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
 * 档位分布：向导建议 common 之前，先看看别人的分档作为基线。
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
      // 平台规则：没写 tier ⇒落进 advanced（web/src/lib/engines.js:164）
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
  ENGINE_DIRS,
  REPO_ROOT,
}