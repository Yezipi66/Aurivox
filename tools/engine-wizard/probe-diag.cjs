'use strict'
const path = require('path')
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const { diagnose } = require(path.join(REPO_ROOT, 'tools', 'engine-wizard', 'core', 'validate.js'))
const eng = process.argv[2]
const mf = require(path.join(REPO_ROOT, 'engines', eng, 'manifest.json'))
const out = diagnose(mf)
for (const x of out) {
  console.log('  ', x.level, x.code, JSON.stringify(x.message).slice(0, 200), '->', x.section, x.field)
}
