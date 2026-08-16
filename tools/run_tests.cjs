#!/usr/bin/env node
// Cross-platform test discovery for Windows (the supported desktop platform)
// and POSIX development shells. Do not rely on find/xargs or shell globbing.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const testFiles = []

// Weight and dependency directories hold thousands of files and never
// contain tests. Walking them costs seconds on every run.
const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git',
  'pretrained', 'pretrained_models', 'uvr5_weights', 'models', 'ja_userdic',
])

function collect(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('faster-whisper-')) continue
      collect(full)
    } else if (entry.isFile() && entry.name.endsWith('.node.test.js')) {
      testFiles.push(full)
    }
  }
}

collect(path.join(root, 'lib'))
// Third-party trees carry our own tests for the wrappers we call into.
collect(path.join(root, 'vendor'))
collect(path.join(root, 'web', 'src'))
testFiles.sort()

if (!testFiles.length) {
  console.error('[tests] no *.node.test.js files found')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...testFiles], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) {
  console.error('[tests] failed to launch Node test runner:', result.error.message)
  process.exit(1)
}
process.exit(result.status == null ? 1 : result.status)
