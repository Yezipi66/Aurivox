'use strict'

// ============================================================================
//  跨平台路径 —— 名片上那些「Windows 形状」的路径
//
// ============================================================================
//  为什么有这个文件（2026-09-29）
//
//    Owner 的目标：**理论上全平台兼容**。2026-09-29 量过一遍，结论是
//    **运行时核心已经跨平台了**（ffmpeg.js / memprobe.js 都有 win32+linux+
//    darwin 分支；envCheck.js / launchPlan.js 零平台判断；stdio_transport.py
//    的 POSIX 分支就是为跨平台写的）。
//
//    ⛔ 唯一的真缺口在**名片**：三张真名片 + 模板都把可执行文件写死成
//    `engines/<id>/.venv/Scripts/python.exe`。而同一个虚拟环境在
//    Linux / macOS 上是 `bin/python`，**没有 Scripts/**。
//    ⇒ 后果很具体：一张这么写的名片在 Linux 上永远「没装」，
//      而用户什么都没做错 —— 平台报「解释器不存在」，路径指向一个
//      只在 Windows 上成立的位置。
//
//  ── 契约怎么变的 ──────────────────────────────────────────────────────
//
//    **breaking，没有兼容层。** Owner 2026-09-29 明确：
//    「我们都没有发布，没有任何下游，也没有任何兼容性问题啊，
//      唯一的问题是我们要兼容上游的问题。」
//    ⇒ 名片从「写可执行文件」改成「写虚拟环境目录」，平台推导那个文件。
//    ⭐ 上游兼容指的是 GSV / IndexTTS2 的**代码**，不是我们自己的历史 API。
//
//  ── 形状 ──────────────────────────────────────────────────────────────
//
//    名片写目录：
//        "python": "engines/indextts2/.venv"
//    平台按 process.platform 推导：
//        win32   →  .venv\\Scripts\\python.exe
//        linux   →  .venv/bin/python
//        darwin  →  .venv/bin/python
//
//    ⛔ 不写「三种都试，哪个存在用哪个」—— 那是拿运行时去探测，
//      症状会变成「在 A 机器上碰巧挑中了另一个引擎的解释器」。
//      ⭐ 形状必须由**声明它的那台机器**决定，不由文件系统现状决定。
//
//  ⭐ 纯函数：不读盘、不 spawn、不看 env。platform 显式传入，
//    所以 macOS/Linux 的形状在 Windows 上也能测。
// ============================================================================

const path = require('node:path')

/**
 * 一台机器上，Python 虚拟环境的可执行文件叫什么。
 *
 * @param {string} platform  process.platform（win32 / linux / darwin）
 * @returns {string|null} 相对 venv 目录的可执行文件路径；⛔ 不认识的平台给 null
 */
function venvPythonRelPath (platform) {
  // ⚠ 虚拟环境的布局在 posix 与 windows 上是**结构性**不同，不是命名习惯：
  //   windows 的 Scripts/ 来自那个年代 .cmd 包装脚本的做法；
  //   posix 一直是 bin/。venv 库按 sys.platform 选目录，不看发行版。
  if (platform === 'win32') return path.join('Scripts', 'python.exe')
  if (platform === 'linux' || platform === 'darwin') return path.join('bin', 'python')
  // ⛔ FreeBSD / aix / 之类：⛔ 不猜。
  //   猜错的后果是「指到一个不存在的文件」⇒ 报「引擎没装」，
  //   而用户什么都没做错。给 null 让调用方说「这个平台我不支持」，
  //   那是一句用户能看懂的话。
  return null
}

/**
 * 名片上的 `runtime.python` 落到可执行文件。
 *
 * @param {string} venvDirAbs 虚拟环境目录的绝对路径
 * @param {string} platform   process.platform
 * @returns {{ok:true, python:string} | {ok:false, why:string}}
 */
function venvPython (venvDirAbs, platform) {
  const rel = venvPythonRelPath(platform)
  if (!rel) {
    return {
      ok: false,
      why: `这个平台（${platform || '未知'}）没有对应的 Python 虚拟环境布局，` +
           `平台不知道该去找哪个可执行文件。`,
    }
  }
  return { ok: true, python: path.join(venvDirAbs, rel) }
}

/**
 * ⭐ 名片解析阶段用：把 `runtime.python` 这个**声明**变成可执行文件。
 *
 * @param {string} rootDirAbs 项目根
 * @param {string} declared   名片里写的（现在约定是**虚拟环境目录**）
 * @param {string} platform
 * @returns {string} 绝对路径
 */
function resolveEnginePython (rootDirAbs, declared, platform) {
  const venvDir = path.resolve(rootDirAbs, declared)
  const r = venvPython(venvDir, platform)
  // ⛔ 不支持的平台：仍给一个**形状正确的**路径（按 posix 算），
  //   目的是让「解释器不存在」这条老报错继续成立 ——
  //   换成别的错误形状会让「这台引擎没装」变成一句更难懂的话。
  //   ⭐ 而 envCheck 那层会另外报「这个平台不支持」，两件事分开说。
  return r.ok ? r.python : path.join(venvDir, venvPythonRelPath('linux'))
}

module.exports = {
  venvPythonRelPath,
  venvPython,
  resolveEnginePython,
}
