'use strict'

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
