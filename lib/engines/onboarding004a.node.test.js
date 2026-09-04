'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { planAdmission } = require('./residency')
const { acceptedRequestKeys } = require('./paramTable')
const ROOT = path.resolve(__dirname, '../..')

test('004A: known RAM shortage asks instead of hard-rejecting', () => {
  const r = planAdmission({ residents: [], id: 'demo', key: 'k', onDemand: true, freeMb: 2500, needMb: 8574, headroom: 1.15, confirmed: false, now: 1 })
  assert.equal(r.action, 'needs_confirm')
  assert.equal(r.mem.wantMb, 9861)
  assert.deepEqual(r.evict, [])
})

test('004A: explicit one-request confirmation preserves the right to try', () => {
  const r = planAdmission({ residents: [], id: 'demo', key: 'k', onDemand: true, freeMb: 1, needMb: 999999, headroom: 1.15, confirmed: true, now: 1 })
  assert.equal(r.action, 'start')
})

test('004A: confirmation is a platform key, not an engine parameter', () => {
  assert.equal(acceptedRequestKeys().has('memory_risk_confirmed'), true)
})

test('004A: Generate retries once with the explicit confirmation flag', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/src/components/generate/GenerateTab.jsx'), 'utf8')
  assert.match(src, /ENGINE_MEMORY_CONFIRM_REQUIRED/)
  assert.match(src, /memory_risk_confirmed:\s*true/)
  assert.match(src, /!body\.memory_risk_confirmed/)
})

test('004A: safe Supervisor errors are whitelisted; unknown errors remain generic', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/services/synthesisService.js'), 'utf8')
  assert.match(src, /safeSupervisorCodes/)
  assert.match(src, /ENGINE_MEMORY_CONFIRM_REQUIRED/)
  assert.match(src, /throw err;/)
  assert.doesNotMatch(src, /new HttpError\([^\n]*err\.stack/)
})
