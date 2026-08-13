'use strict'

const crypto = require('crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Mutex } = require('../util/mutex')
const {
  JOURNAL_SCHEMA,
  JOURNAL_SCHEMA_VERSION,
  appendJournalEvent,
  replayJournal,
} = require('./runJournal')

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/
const FILE_SUFFIX = '.journal.ndjson'
const HEADER_KIND = 'header'
const EVENT_KIND = 'event'

function storeError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw storeError('RUN_ID_INVALID', 'run_id must match [a-zA-Z0-9_-]+')
}

function validateJournal(journal) {
  if (!journal || journal.schema !== JOURNAL_SCHEMA || journal.schema_version !== JOURNAL_SCHEMA_VERSION || !Array.isArray(journal.events)) {
    throw storeError('JOURNAL_INVALID', 'unsupported or malformed Run Journal')
  }
  validateRunId(journal.run_id)
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function pathExists(file) {
  try {
    await fs.access(file)
    return true
  } catch (_) {
    return false
  }
}

class FileRunJournalStore {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || !rootDir) throw storeError('JOURNAL_ROOT_REQUIRED', 'rootDir is required')
    this.rootDir = path.resolve(rootDir)
    this.locks = new Map()
  }

  pathFor(runId) {
    validateRunId(runId)
    return path.join(this.rootDir, `${runId}${FILE_SUFFIX}`)
  }

  _mutex(runId) {
    let mutex = this.locks.get(runId)
    if (!mutex) {
      mutex = new Mutex()
      this.locks.set(runId, mutex)
    }
    return mutex
  }

  async _withRunLock(runId, fn) {
    return this._mutex(runId).runExclusive(fn)
  }

  _headerFromJournal(journal) {
    const header = { ...journal }
    delete header.events
    return { kind: HEADER_KIND, ...header }
  }

  async _readWithInfo(runId, { repairTail = true } = {}) {
    const file = this.pathFor(runId)
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw storeError('JOURNAL_NOT_FOUND', `Run Journal '${runId}' does not exist`, { run_id: runId })
      throw error
    }
    const lines = raw.split('\n')
    const hasTrailingNewline = raw.endsWith('\n')
    if (lines.length === 0 || !lines[0].trim()) throw storeError('JOURNAL_CORRUPT', `Run Journal '${runId}' has no header`)

    let header
    try {
      header = JSON.parse(lines[0])
    } catch (error) {
      throw storeError('JOURNAL_CORRUPT', `Run Journal '${runId}' has an invalid header`, { run_id: runId, cause: error.message })
    }
    if (header.kind !== HEADER_KIND || header.schema !== JOURNAL_SCHEMA || header.schema_version !== JOURNAL_SCHEMA_VERSION || header.run_id !== runId) {
      throw storeError('JOURNAL_INVALID', `Run Journal '${runId}' has an unsupported header`)
    }

    const events = []
    let byteOffset = Buffer.byteLength(`${lines[0]}\n`, 'utf8')
    let repairOffset = null
    let needsSeparator = !hasTrailingNewline
    const lastLineIndex = lines.length - (hasTrailingNewline ? 2 : 1)
    for (let index = 1; index <= lastLineIndex; index += 1) {
      const line = lines[index]
      const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8')
      if (!line.trim()) {
        byteOffset += lineBytes
        continue
      }
      let record
      try {
        record = JSON.parse(line)
      } catch (error) {
        const isTornTail = index === lastLineIndex && !hasTrailingNewline
        if (isTornTail && repairTail) {
          repairOffset = byteOffset
          break
        }
        throw storeError('JOURNAL_CORRUPT', `Run Journal '${runId}' has invalid event line ${index + 1}`, { run_id: runId, line: index + 1, cause: error.message })
      }
      if (!record || record.kind !== EVENT_KIND || !record.event || typeof record.event !== 'object') {
        throw storeError('JOURNAL_CORRUPT', `Run Journal '${runId}' has invalid event record ${index + 1}`, { run_id: runId, line: index + 1 })
      }
      events.push(record.event)
      byteOffset += lineBytes
    }

    if (repairOffset !== null) {
      await fs.truncate(file, repairOffset)
      needsSeparator = false
    }

    const journal = {
      schema: header.schema,
      schema_version: header.schema_version,
      run_id: header.run_id,
      workflow_id: header.workflow_id || null,
      workflow_revision_id: header.workflow_revision_id || null,
      workflow_fingerprint: header.workflow_fingerprint || null,
      run_plan_fingerprint: header.run_plan_fingerprint || null,
      workflow_input_snapshot: header.workflow_input_snapshot || null,
      events,
    }
    validateJournal(journal)
    replayJournal(journal)
    return { journal, needsSeparator }
  }

  async _readUnlocked(runId) {
    const parsed = await this._readWithInfo(runId)
    return parsed.journal
  }

  async _writeNewJournal(file, journal) {
    await fs.mkdir(this.rootDir, { recursive: true })
    const header = this._headerFromJournal(journal)
    const lines = [JSON.stringify(header)]
    for (const event of journal.events) lines.push(JSON.stringify({ kind: EVENT_KIND, event }))
    const handle = await fs.open(file, 'wx')
    try {
      await handle.write(`${lines.join('\n')}\n`, null, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async _appendEvent(file, event, needsSeparator) {
    const handle = await fs.open(file, 'a')
    try {
      const prefix = needsSeparator ? '\n' : ''
      await handle.write(`${prefix}${JSON.stringify({ kind: EVENT_KIND, event })}\n`, null, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async create(journal) {
    validateJournal(journal)
    const runId = journal.run_id
    return this._withRunLock(runId, async () => {
      const file = this.pathFor(runId)
      if (await pathExists(file)) throw storeError('JOURNAL_ALREADY_EXISTS', `Run Journal '${runId}' already exists`, { run_id: runId })
      replayJournal(journal)
      await this._writeNewJournal(file, journal)
      return clone(journal)
    })
  }

  async read(runId) {
    validateRunId(runId)
    return this._readUnlocked(runId)
  }

  async append(runId, event) {
    validateRunId(runId)
    return this._withRunLock(runId, async () => {
      const parsed = await this._readWithInfo(runId)
      const next = appendJournalEvent(parsed.journal, event)
      const appended = next.events[next.events.length - 1]
      await this._appendEvent(this.pathFor(runId), appended, parsed.needsSeparator)
      return clone(next)
    })
  }

  async replay(runId) {
    return replayJournal(await this.read(runId))
  }

  async listRunIds() {
    try {
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile() && entry.name.endsWith(FILE_SUFFIX))
        .map(entry => entry.name.slice(0, -FILE_SUFFIX.length))
        .filter(runId => RUN_ID_RE.test(runId))
        .sort()
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  }

  async remove(runId) {
    validateRunId(runId)
    return this._withRunLock(runId, async () => {
      await fs.rm(this.pathFor(runId), { force: true })
    })
  }
}

module.exports = {
  FILE_SUFFIX,
  FileRunJournalStore,
  RUN_ID_RE,
}
