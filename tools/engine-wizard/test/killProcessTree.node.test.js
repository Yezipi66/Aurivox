'use strict'
// killProcessTree 的守卫：杀完之后那个进程真的死了。
// 两条实现路径完全不同（Windows 走 taskkill /T /F，posix 走信号），
// 平台显式传入 platform 参数，posix 那条在任何机器上都能被测到。
// posix 那条必须先杀进程本身：spawn 默认不设 detached，子进程与父进程同组，
// 负 PID 指的是「组 ID 等于 child.pid 的那个组」，而它并不存在。

const { test } = require('node:test')
const assert = require('node:assert')
const { spawn, spawnSync } = require('node:child_process')

const { killProcessTree } = require('../core/clone.js')

/**
 * 那个进程还活着吗。
 * Windows 上不能用 taskkill 问：它会真的杀掉那个进程
 *   （/PID 不带 /F 也是终止信号）⇒ 探查本身改变了被探查的对象。
 * 改用「按 pid 查得到吗」：查得到说明进程还在。
 */
function alive (pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `try { $p = Get-Process -Id ${pid} -ErrorAction Stop; exit 0 } catch { exit 1 }`,
    ], { encoding: 'utf8', windowsHide: true })
    return r.status === 0
  }
  try {
    // 信号 0 只做「能不能送达」的探查，不真的杀
    process.kill(pid, 0)
    return true
  } catch (e) {
    return false
  }
}

/** 等一下，让被杀的进程真的退出 */
function delay (ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 起一个会一直跑的进程，等它进入循环 */
async function startForever () {
  const child = spawn(process.execPath, ['-e', 'while(1);'],
    { stdio: 'ignore', windowsHide: true })
  await delay(300)
  return child
}

/** 等到它不再活着（最多等 2 秒） */
async function waitDead (pid) {
  for (let i = 0; i < 20 && alive(pid); i++) await delay(100)
  return !alive(pid)
}

test('killProcessTree 杀完之后，那个进程真的死了（本平台）', async () => {
  const child = await startForever()
  const pid = child.pid
  assert.ok(pid, '进程应该起来了')
  assert.ok(alive(pid), '前提：杀掉之前那个进程还活着')

  killProcessTree(child)

  assert.ok(await waitDead(pid),
    `pid ${pid} 还在跑 —— killProcessTree 没杀掉它。`
    + '在这个平台上它会一直跑，node --test 等它退出 ⇒ 整轮测试挂住。')
})

test('killProcessTree 的 posix 那条：显式传 platform 时也杀得掉', async () => {
  // 这条在 Windows 上也跑：显式传 'linux' ⇒ 走 posix 那条实现。
  const child = await startForever()
  const pid = child.pid
  assert.ok(alive(pid), '前提：杀掉之前那个进程还活着')

  killProcessTree(child, 'linux')

  assert.ok(await waitDead(pid),
    `pid ${pid} 还在跑 —— posix 那条实现没杀掉它。`
    + '在 Linux 上它会一直跑，node --test 等它退出 ⇒ 整轮测试挂住。')
})

test('killProcessTree 对已退出的进程不抛（它可能已经自己结束了）', () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'],
    { stdio: 'ignore', windowsHide: true })
  // 不等它退：直接杀一个可能已经没了的进程，不许抛
  assert.doesNotThrow(() => killProcessTree(child))
  assert.doesNotThrow(() => killProcessTree(child))
})

test('killProcessTree 对空输入不抛', () => {
  assert.doesNotThrow(() => killProcessTree(null))
  assert.doesNotThrow(() => killProcessTree(undefined))
})
