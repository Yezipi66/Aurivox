'use strict'
// 本机测得的超时：第 5 步试运行在本机上量到的冷启动、单段合成耗时（已按余量放大）。
//
// 为什么不进名片：名片描述的是引擎本身，要能原样分享给别人；「在本机上多快」
//   换一台机器（CPU/GPU、核数、盘速）就不成立，只能拿来给本机定超时。
//   与 memledger.js 记内存峰值是同一类数：平台自己量、只对本机有效、不进仓库。
//
// 落盘：<根>/state/engine-timings/<id>.json，一台引擎一份，每次试运行整份覆盖。
//   state/ 整个被 .gitignore 排除。根由调用方给：平台读用 APP_DIR，向导写用写根
//   （tools/engine-wizard/core/wizardRoot.js 的 writeRoot）。
// 读的一侧在 profile.js：本机测得 > 名片里写的 > 平台默认。
//
// 读不出来（没有、坏了、数不合法）一律当没测过，不抛：本机记录坏了不该让引擎装不上，
//   退回名片或平台默认就是「没测过」本来的样子。

const fs = require('node:fs')
const path = require('node:path')

const VERSION = 1
const DIR_NAME = path.join('state', 'engine-timings')

// 只有这两项按本机定。max_chars 是引擎自身的属性（一次能合成多长），不在这里。
const LOCAL_KEYS = Object.freeze(['timeout_ms', 'runtime.ready_timeout_ms'])

// id 要能当文件名，且不能借 ../ 跑出 state/engine-timings/。
function safeId (id) {
  const s = String(id || '')
  return s && /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..' ? s : null
}

function timingsPath (rootDir, id) {
  const sid = safeId(id)
  if (!rootDir || !sid) return null
  return path.join(rootDir, DIR_NAME, `${sid}.json`)
}

function positiveInt (v) {
  return Number.isInteger(v) && v > 0 ? v : null
}

/**
 * 读一台引擎的本机记录。
 * @returns {{values: object, measured_at: string|null, path: string}|null}
 *   values 只含合法的项（键为 LOCAL_KEYS 里的路径）；一项都没有 ⇒ null。
 */
function readTimings (rootDir, id) {
  const p = timingsPath(rootDir, id)
  if (!p) return null
  let j
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
  if (!j || typeof j !== 'object' || !j.values || typeof j.values !== 'object') return null
  const values = {}
  for (const k of LOCAL_KEYS) {
    const v = positiveInt(j.values[k])
    if (v !== null) values[k] = v
  }
  if (!Object.keys(values).length) return null
  return { values, measured_at: typeof j.measured_at === 'string' ? j.measured_at : null, path: p }
}

/**
 * 整份覆盖写一台引擎的本机记录。先写临时文件再改名，不完整的 JSON 不会留在盘上。
 * @param {object} values   { timeout_ms?, 'runtime.ready_timeout_ms'? }，其它键丢掉
 * @param {object} [extra]  { readings, measured_at }：量到的原始读数，只给人看，平台不读
 * @returns {{ok:boolean, path?:string, values?:object, error?:string}}
 */
function writeTimings (rootDir, id, values, extra = {}) {
  const p = timingsPath(rootDir, id)
  if (!p) return { ok: false, error: `引擎 id 不合法，不能当文件名：${JSON.stringify(id)}` }
  const clean = {}
  for (const k of LOCAL_KEYS) {
    const v = positiveInt(values && values[k])
    if (v !== null) clean[k] = v
  }
  if (!Object.keys(clean).length) return { ok: false, error: '没有可写的值' }
  const body = {
    version: VERSION,
    id: String(id),
    measured_at: extra.measured_at || new Date().toISOString(),
    values: clean,
    readings: extra.readings || null,
  }
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const tmp = `${p}.tmp.${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, p)
  } catch (e) {
    return { ok: false, error: `写不进本机记录 ${p}：${e.message}` }
  }
  return { ok: true, path: p, values: clean }
}

module.exports = { LOCAL_KEYS, DIR_NAME, timingsPath, readTimings, writeTimings }
