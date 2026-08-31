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
// r12c: that third-party code now lives in engines/ (per-engine) and
// pipeline/ (engine-agnostic tools); vendor/ holds only prebuilt binaries,
// which carry no tests of ours. Keep scanning vendor/ anyway so a stray
// wrapper landing there is not silently untested.
collect(path.join(root, 'engines'))
collect(path.join(root, 'pipeline'))
collect(path.join(root, 'vendor'))
collect(path.join(root, 'web', 'src'))
// ⭐⭐⭐ 2026-08-31：`tools\` 此前**不在这份名单里**。
//   我把 `tools\count_nails.node.test.js` 写完、跑了全量测试、看到 1511 全绿 ——
//   而那个文件**一条都没跑过**，且没有任何输出提示它被跳过了。
//   ⛔ 这是最坏的一种失败：一条"守卫"存在、被 review、被写进契约，却从不执行。
//   ⇒ 下面那段自检就是为此加的：名单漏了哪个目录，当场喊出来。
collect(path.join(root, 'tools'))
testFiles.sort()

if (!testFiles.length) {
  console.error('[tests] no *.node.test.js files found')
  process.exit(1)
}

// ============================================================
//  自检：仓库里每一个 *.node.test.js 都必须在上面的名单里
// ============================================================
//
// ⭐ 判据：**"没跑"和"跑过并且绿了"在输出里必须长得不一样。**
//   上面那些 collect() 是一份**手写的目录名单** —— 手写名单会漏，
//   而漏掉的代价是一条永远不会红的测试（比没有测试更坏：它给人安全感）。
//
// ⛔ 禁令：发现漏了不许在这里 `continue` 跳过，去上面加一行 collect()。
// 预言（可证伪）：下一次有人在一个新目录（`scripts\`? `deploy\`?）里写测试，
//   他会以为跑全量就跑到了。这段自检会当场告诉他没有。
{
  const seen = new Set(testFiles)
  const orphans = []
  const scanAll = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('faster-whisper-')) continue
        scanAll(full)
      } else if (entry.isFile() && entry.name.endsWith('.node.test.js') && !seen.has(full)) {
        orphans.push(path.relative(root, full))
      }
    }
  }
  scanAll(root)
  if (orphans.length) {
    console.error('[tests] ⛔ 下面这些测试文件不在扫描名单里，它们一条都不会跑：')
    for (const o of orphans) console.error('        ' + o)
    console.error('[tests] ⇒ 去 tools/run_tests.cjs 加一行 collect(...)，⛔ 不许忽略这条')
    process.exit(1)
  }
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
