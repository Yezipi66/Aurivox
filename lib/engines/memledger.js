'use strict'
// memledger：每台引擎「历史上最多吃过多少内存」的账本。
// 必须落盘：操作系统的峰值统计随进程一起消失，跨重启只有这份账本记得住。
// 这些数不进名片：作者答不上来（取决于机器、权重、文本长度），只有平台能测出来。

const fs = require('fs')
const path = require('path')

const FILE_NAME = 'engine_memory.json'
const VERSION = 1

/**
 * 冷启动种子：只在引擎从没跑过时用一次，跑过就被量到的峰值覆盖。
 * 不许按引擎 id 写死具体数字：装一台谁都没见过的引擎，这些文件必须一个字都不用改。
 */
const SEED_MB = null   // null = 没有种子 ⇒ 走「第一次，问用户」那条路

function ledgerPath(rootDir) {
  return path.join(rootDir, 'state', FILE_NAME)
}

function emptyLedger() {
  return { version: VERSION, engines: {}, attempting: {} }
}

/** 读账本。读不出来一律当空账本，不抛：账本坏了不该让引擎起不来。 */
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
    // 先写临时文件再改名：不完整的 JSON 会让下次开机无法读取账本。
    const tmp = p + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), 'utf8')
    fs.renameSync(tmp, p)
    return true
  } catch {
    return false   // 写不进去不抛。记不住账是遗憾，起不了引擎是故障。
  }
}

/**
 * 记一笔峰值。只涨不落：账本存的是「最多吃过多少」，按上次的记，跑一次短文本就会把
 * 上次长文本的教训抹掉。peakMb 非正数整笔丢掉，绝不写 0（写 0 = 声称这台引擎不吃内存）。
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
 * 这台引擎现在的判据是多少 MB。null = 从未测量过。
 * null 和 0 必须分得开：null 是「不知道」（⇒ 问用户），0 是「不吃内存」（⇒ 随便起）。
 */
function needMb(rootDir, id, opts = {}) {
  const ledger = opts.ledger || load(rootDir)
  const rec = ledger.engines[id]
  if (rec && Number.isFinite(rec.peakMb) && rec.peakMb > 0) return rec.peakMb
  return SEED_MB
}

/**
 * 起之前先落一条「正在试 X」。被 OOM 打死的进程来不及让我们读峰值，那次峰值就白费了；
 * 下次开机看见这条还在，就知道「X 上次未正常退出」。
 * 它区分不了「被 OOM 杀了」和「用户直接拔电源」：两种都值得谨慎。
 */
function markAttempting(rootDir, id, opts = {}) {
  if (!id) return null
  const ledger = opts.ledger || load(rootDir)
  ledger.attempting[id] = { startedAt: Number.isFinite(opts.now) ? opts.now : Date.now() }
  if (!opts.noWrite) save(rootDir, ledger)
  return ledger
}

/**
 * 开机时结上一轮的账：所有还挂着「正在试」的，都是上次未正常退出的。
 * @returns {string[]} 上次未正常退出的引擎 id
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

/** 这台引擎有没有崩过：用来把提醒的话说得更重一点。 */
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
