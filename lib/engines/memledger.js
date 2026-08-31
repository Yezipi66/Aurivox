'use strict'
// ---------------------------------------------------------------------------
//  memledger —— 每台引擎「历史上最多吃过多少内存」的账本。
//
//  ⭐⭐⭐ 为什么必须落盘：操作系统替我们免费记着峰值，但那个数**跟着进程
//    的命**。进程一重启就归零。跨重启只有我们自己记得住。
//    不落盘 ⇒ 后端每重启一次就把教训忘光 ⇒ 每次开机第一次起都在赌，
//    那个教训永远学不会。
//
//  ⛔ 这里存的数**不进名片**。跟端口同理：作者答不上来（取决于装在谁的
//    机器上、装了哪份权重、跑多长的文本），只有平台在这台机器上量得出来。
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')

const FILE_NAME = 'engine_memory.json'
const VERSION = 1

/**
 * 冷启动种子 —— **只在一台引擎从没跑过的时候用一次**，跑过一次就被实测覆盖。
 *
 * ⭐ 一个会被自己覆盖掉的数，不值得调准。⛔ 别为这里的数字花时间。
 * ⛔ 也不许在这里按引擎 id 写死具体数字（residency.js 那条守卫的同一个理由：
 *   装一台谁都没见过的引擎，这些文件必须一个字都不用改）。
 */
const SEED_MB = null   // null = 没有种子 ⇒ 走「第一次，问用户」那条路

function ledgerPath(rootDir) {
  return path.join(rootDir, 'state', FILE_NAME)
}

function emptyLedger() {
  return { version: VERSION, engines: {}, attempting: {} }
}

/** 读账本。⛔ 读不出来一律当空账本，不抛 —— 账本坏了不该让引擎起不来。 */
function load(rootDir) {
  try {
    const raw = fs.readFileSync(ledgerPath(rootDir), 'utf8')
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return emptyLedger()
    return {
      version: VERSION,
      engines: (j.engines && typeof j.engines === 'object') ? j.engines : {},
      attempting: (j.attempting && typeof j.attempting === 'object') ? j.attempting : {},
    }
  } catch {
    return emptyLedger()
  }
}

function save(rootDir, ledger) {
  const p = ledgerPath(rootDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // 先写临时文件再改名 —— 半截的 JSON 会让下次开机读不出账本。
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    return true
  } catch {
    return false   // ⛔ 写不进去不抛。记不住账是遗憾，起不了引擎是故障。
  }
}

/**
 * 记一笔实测。
 *
 * ⭐ **只涨不落**：账本存的是「最多吃过多少」，不是「上次吃了多少」。
 *   按上次的记，跑一次短文本就会把上次长文本的教训抹掉 ⇒ 下次长文本 OOM。
 * ⛔ peakMb 不是正数就整笔丢掉，绝不写 0（写 0 = 声称这台引擎不吃内存）。
 */
function record(rootDir, id, peakMb, opts = {}) {
  if (!id) return null
  if (!Number.isFinite(peakMb) || peakMb <= 0) return null
  const ledger = opts.ledger || load(rootDir)
  const prev = ledger.engines[id]
  const prevPeak = prev && Number.isFinite(prev.peakMb) ? prev.peakMb : 0
  ledger.engines[id] = {
    peakMb: Math.max(prevPeak, Math.round(peakMb)),
    lastMb: Math.round(peakMb),
    samples: (prev && Number.isInteger(prev.samples) ? prev.samples : 0) + 1,
    crashes: prev && Number.isInteger(prev.crashes) ? prev.crashes : 0,
    updatedAt: Number.isFinite(opts.now) ? opts.now : Date.now(),
  }
  // 量到数了 ⇒ 这次尝试是活着回来的，把「正在试」的标记清掉。
  delete ledger.attempting[id]
  if (!opts.noWrite) save(rootDir, ledger)
  return ledger.engines[id]
}

/**
 * 这台引擎现在的判据是多少 MB。null = 从来没量到过。
 *
 * ⭐ null 和 0 必须分得开：null 是「不知道」（⇒ 问用户），
 *   0 是「不吃内存」（⇒ 随便起）。混起来会把最危险的情况当成最安全的。
 */
function needMb(rootDir, id, opts = {}) {
  const ledger = opts.ledger || load(rootDir)
  const rec = ledger.engines[id]
  if (rec && Number.isFinite(rec.peakMb) && rec.peakMb > 0) return rec.peakMb
  return SEED_MB
}

/**
 * 起之前先落一条「正在试 X」。
 *
 * ⭐⭐ 这条是给**崩掉那次**准备的。被 OOM 打死的进程来不及让我们读峰值，
 *   那次实测就白费了 —— 下次还会用同样的无知去赌同一把。
 *   起之前先记一笔，下次开机看见这条还在，就知道「X 上次没活着回来」。
 * ⚠ 它区分不了「被 OOM 杀了」和「用户直接拔电源」。不要紧：两种都值得谨慎。
 */
function markAttempting(rootDir, id, opts = {}) {
  if (!id) return null
  const ledger = opts.ledger || load(rootDir)
  ledger.attempting[id] = { startedAt: Number.isFinite(opts.now) ? opts.now : Date.now() }
  if (!opts.noWrite) save(rootDir, ledger)
  return ledger
}

/**
 * 开机时结上一轮的账：所有还挂着「正在试」的，都是没活着回来的。
 * @returns {string[]} 上次没活着回来的引擎 id
 */
function reapAttempts(rootDir, opts = {}) {
  const ledger = opts.ledger || load(rootDir)
  const ids = Object.keys(ledger.attempting || {})
  if (!ids.length) return []
  for (const id of ids) {
    const prev = ledger.engines[id] || { peakMb: 0, lastMb: 0, samples: 0, crashes: 0 }
    prev.crashes = (Number.isInteger(prev.crashes) ? prev.crashes : 0) + 1
    ledger.engines[id] = prev
    delete ledger.attempting[id]
  }
  if (!opts.noWrite) save(rootDir, ledger)
  return ids
}

/** 这台引擎有没有崩过 —— 用来把提醒的话说得更重一点。 */
function crashesOf(rootDir, id, opts = {}) {
  const ledger = opts.ledger || load(rootDir)
  const rec = ledger.engines[id]
  return rec && Number.isInteger(rec.crashes) ? rec.crashes : 0
}

module.exports = {
  FILE_NAME,
  VERSION,
  SEED_MB,
  ledgerPath,
  emptyLedger,
  load,
  save,
  record,
  needMb,
  markAttempting,
  reapAttempts,
  crashesOf,
}
