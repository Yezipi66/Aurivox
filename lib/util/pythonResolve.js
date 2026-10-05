'use strict'

// ============================================================================
//  选一个「真的能按绝对路径跑起来」的 Python
//
// ============================================================================
//  ⭐ 为什么要有这个文件（2026-10-04）
//
//  同一个「找一个能用的解释器」的函数当时有**三份副本**
//  （configRepair / aliasFold / envCheck 三个 .node.test.js），
//  而三份的判据都是 **`fs.existsSync(p)` —— 文件在就算数**。
//
//  ⛔ 那在本机上是错的，而且错得很安静：
//
//    venv/Scripts/python.exe   ← 文件在
//                                pyvenv.cfg 的 home 指向另一台机器
//                                启动报 uv trampoline failed to spawn
//
//  ⇒ 「文件在」与「能跑」在 venv 上是两件事。而**失败发生在流程后段**
//  （读名片、算路径、起引擎），那时候人已经等了很久。
//
//  ⚠️ 而修它不能只看「能不能跑」，还要看**能不能按绝对路径跑** —— 因为
//  调用方（envCheck 的深层校验）要把这个路径交给平台做
//  `path.resolve(rootDir, runtime.python)` 的路径运算，而**裸名字参与不了**。
//
//  ⭐⭐ 还有一个更窄的坑（2026-10-04 实测）：
//
//  某个 python 的安装路径里带 `*`（例如版本号 `202****0901`）：
//    · 按裸名 spawn      → 正常
//    · 按绝对路径 spawn  → ENOENT
//    · `path.relative` / `path.resolve` 处理它 → **反斜杠被吃掉**，路径变成
//      `C:\UsersUserAppDataLocalhermes\...`，round-trip 不成立
//
//  ⇒ 所以「PATH 上能跑」**不够**：必须验证它的 `sys.executable`
//  也能按绝对路径 spawn，否则会造出一条指不到任何地方的 runtime.python，
//  测试会以「Cannot read properties of undefined」这种看不出病因的形状挂掉。
//
// ⛔⛔ 纪律：不许出现任何具体引擎名，也不许写死任何绝对路径。
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/** ⭐ 探测用的代码：必须真的执行一点东西，不能只问版本号。
 *  坏掉的 uv trampoline 对 `--version` 和 `-c` 一样报错，但
 *  「打印得出版本」与「能执行代码」在破损安装上确实会分叉 —— 以后者为准。 */
const PROBE_CODE = 'import sys; sys.stdout.write(sys.executable)'

const PROBE_TIMEOUT_MS = 20000

/**
 * 这个可执行文件**能不能按绝对路径起起来并执行代码**。
 *
 * ⛔ 传进来的必须是绝对路径 —— 本文件存在的全部理由就是「按绝对路径能跑」，
 * 而裸名字通过不代表它的绝对路径也能跑（见文件头那个带 `*` 的坑）。
 *
 * @param {string} exe
 * @param {{timeoutMs?:number}} [opts]
 * @returns {boolean}
 */
function canSpawnPython (exe, opts = {}) {
  if (!exe || typeof exe !== 'string') return false
  // ⛔ 相对路径 / 裸名字一律判否：那正是本文件要防的形状。
  if (!path.isAbsolute(exe)) return false
  let st
  try { st = fs.statSync(exe) } catch (e) { return false }
  // ⚠️ 目录也会被 existsSync 判成「在」。spawn 一个目录必然失败，
  //   而提前判否能让报错更早出现在这一行而不是 spawn 那边。
  if (!st.isFile()) return false

  let r
  try {
    r = spawnSync(exe, ['-c', PROBE_CODE], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,      // ⛔ 走 shell 会被带空格的路径坑
    })
  } catch (e) {
    return false
  }
  if (r.error || r.status !== 0) return false
  // ⚠️ 一定要它把 sys.executable 吐出来 —— 拿不到就说明这个解释器
  //   行为不正常，而我们要的就是这个路径本身。
  return Boolean((r.stdout || '').trim())
}

/**
 * 按给定顺序找第一个能用的解释器；全都不行时试 PATH。
 *
 * ⭐ PATH 分支**不是**「裸名能跑就返回裸名」：它先借裸名问出
 * `sys.executable`，再**按绝对路径复核一遍**。理由见文件头。
 *
 * @param {string[]} candidates 绝对路径候选，按优先级
 * @param {{timeoutMs?:number, pathNames?:string[]}} [opts]
 * @returns {string|null} 绝对路径；一个都没有时 null
 */
function firstWorkingPython (candidates, opts = {}) {
  for (const c of candidates || []) {
    if (canSpawnPython(c, opts)) return c
  }
  for (const name of (opts.pathNames || ['python3', 'python'])) {
    const abs = askPathForAbsolute(name, opts)
    if (abs && canSpawnPython(abs, opts)) return abs
  }
  return null
}

/**
 * 借一个 PATH 上的**裸名字**问出它自己的绝对路径。
 * 问不到就 null —— ⛔ 绝不返回裸名字（它参与不了路径运算）。
 */
function askPathForAbsolute (name, opts = {}) {
  let r
  try {
    r = spawnSync(name, ['-c', PROBE_CODE], {
      encoding: 'utf8',
      timeout: opts.timeoutMs || PROBE_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
    })
  } catch (e) {
    return null
  }
  if (r.error || r.status !== 0) return null
  const abs = (r.stdout || '').trim()
  // ⚠️ 有些包装器会把自己的启动器路径吐出来而不是真解释器；
  //   非绝对路径的一律不要（那等于把裸名字放回去）。
  return abs && path.isAbsolute(abs) ? abs : null
}

/**
 * 项目里「该按顺序试哪几个解释器」的**默认尾巴**。
 *
 * ⭐ 为什么要把「仓库内嵌 runtime」也列进来：
 * 它是本仓库自带的**可重定位**解释器（`deploy.bat` 就用它建 venv），
 * 绝对路径可用、跨机器有效。而 PATH 上的 python 可能是：
 *   · 一个**装得很碎**的解释器（连 pydantic 都没有）
 *   · 一个**绝对路径不可用**的解释器（见文件头那个带 `*` 的坑）
 * ⇒ 把它放在 PATH 兜底**之前**，是这三者里最可靠的一个。
 *
 * ⚠️ 但它**不是万能的**：它是裸解释器，没有 torch / pydantic。
 * 需要第三方包的测试会因此拿到它、然后在 import 处失败 ——
 * 那种失败是**响亮的**（ModuleNotFoundError），比悄悄用错环境好。
 *
 * @param {string} rootDir  项目根（绝对路径）
 * @param {string[]} [leading]  排在最前面的候选（例如某台引擎自己的 venv）
 * @returns {string[]} 绝对路径候选，按优先级
 */
function projectPythonCandidates (rootDir, leading = []) {
  return [
    ...leading,
    path.join(rootDir, 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, 'venv', 'bin', 'python'),
    // ⭐ 仓库内嵌、可重定位 —— 绝对路径可用
    path.join(rootDir, 'tools', 'runtime', 'python', 'python.exe'),
    path.join(rootDir, 'tools', 'runtime', 'python', 'bin', 'python3'),
  ]
}

module.exports = {
  canSpawnPython, firstWorkingPython, askPathForAbsolute,
  projectPythonCandidates, PROBE_CODE,
}
