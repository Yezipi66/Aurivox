'use strict'

// 工作流子系统的对外出口：把节点注册表、校验、运行状态、人工门、Run Journal、
// 持久化、执行器、产物存储与旧版合成适配器的导出摊平到同一个 module.exports。
// 只做聚合，不新增逻辑；同名导出目前不存在冲突，新增导出时不要覆盖已有的名字。

const registry = require('./nodeRegistry')
const validator = require('./validator')
const runState = require('./runState')
const humanGate = require('./humanGate')
const runJournal = require('./runJournal')
const fileJournalStore = require('./fileJournalStore')
const executor = require('./executor')
const artifactStore = require('./artifactStore')
const legacySynthesis = require('./adapters/legacySynthesis')

module.exports = {
  ...registry,
  ...validator,
  ...runState,
  ...humanGate,
  ...runJournal,
  ...fileJournalStore,
  ...executor,
  ...artifactStore,
  ...legacySynthesis,
}
