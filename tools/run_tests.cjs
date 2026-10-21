#!/usr/bin/env node
// 测试收集与运行器：找出仓库里全部 *.node.test.js，交给 node --test 跑。
// 不依赖 find/xargs，也不依赖 shell 通配符（Windows 上没有）。
// 三步：按目录名单收集；自检「仓库里每个测试文件都在名单里」；按是否交互终端决定怎么转写输出。
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const testFiles = []

// 权重与依赖目录里没有测试，走一遍要花几秒。
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
// 第三方引擎树与 pipeline/ 里也有我们自己的包装器测试。
// vendor/ 只放预编译二进制，本来没有我们的测试，但仍在名单里：落在那里的包装器
// 不该悄悄没人测。
collect(path.join(root, 'engines'))
collect(path.join(root, 'pipeline'))
collect(path.join(root, 'vendor'))
collect(path.join(root, 'web', 'src'))
collect(path.join(root, 'tools'))
testFiles.sort()

if (!testFiles.length) {
  console.error('[tests] no *.node.test.js files found')
  process.exit(1)
}

// ============================================================
//  自检：仓库里每一个 *.node.test.js 都必须在上面的名单里
//
//  名单是手写的，手写名单会漏；漏掉的代价是一条永远不会红的测试，
//  比没有测试更坏：它给人安全感。
//  发现漏了不许在这里 continue 跳过，去上面加一行 collect(...)，当场喊出来。
// ============================================================
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
    console.error('[tests] 下面这些测试文件不在扫描名单里，它们一条都不会跑：')
    for (const o of orphans) console.error('        ' + o)
    console.error('[tests] ⇒ 去 tools/run_tests.cjs 加一行 collect(...)，不许忽略这条')
    process.exit(1)
  }
}

// stdio 选择：Node 的 test runner 在 stdin 不是 tty 时会整体退出（报 stdin is not a tty），
// 一条测试都不跑。所以交互终端用 inherit 保住实时进度，其余情况改用 pipe 并把子进程
// 输出原样转写。只看 stdin 不够：后台任务与 CI runner 可能报 isTTY 为 true 但没有
// 可用终端，所以要求 stdin 与 stdout 都是 tty 才用 inherit。
const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true
// 非交互时子进程输出会被收上来再原样转写，内存占用是测试输出的量级。
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...testFiles], {
  cwd: root,
  stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
})

if (!interactive) {
  // stdout 是 Buffer（encoding 没设）⇒ 先转成字符串。
  const out = (result.stdout || '').toString()
  process.stdout.write(out)
  process.stderr.write(result.stderr || '')
  // 失败时再打一份摘要：spec reporter 逐条打印两千多条测试名，失败原因在很后面，
  // 日志被截断时正好把原因截掉了。
  if (result.status !== 0) {
    const lines = out.split('\n')
    const failed = lines.filter((l) => /^✖ /.test(l))
    const counts = lines.filter((l) => /^ℹ (tests|pass|fail|skipped) /.test(l))
    console.error('')
    console.error('[tests] 失败摘要：')
    for (const l of counts) console.error('  ' + l)
    if (failed.length) {
      console.error(`  失败 ${failed.length} 条：`)
      for (const l of failed.slice(0, 40)) console.error('    ' + l)
      if (failed.length > 40) console.error(`    …… 还有 ${failed.length - 40} 条`)
    }
  }
}

if (result.error) {
  console.error('[tests] failed to launch Node test runner:', result.error.message)
  process.exit(1)
}
process.exit(result.status == null ? 1 : result.status)
