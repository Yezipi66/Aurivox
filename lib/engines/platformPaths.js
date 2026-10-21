'use strict'

// 名片上的 runtime.python 是虚拟环境目录，平台按 process.platform 推导可执行文件。
// 规则写死在这里，不去文件系统上探测：探测会挑中别的引擎的解释器。

const path = require('node:path')

// 一台机器上，Python 虚拟环境的可执行文件叫什么。相对 venv 目录，不认识的平台给 null。
function venvPythonRelPath (platform) {
  // posix 与 windows 的布局是结构性不同，不是命名习惯：venv 库按 sys.platform 选目录。
  if (platform === 'win32') return path.join('Scripts', 'python.exe')
  if (platform === 'linux' || platform === 'darwin') return path.join('bin', 'python')
  return null // 不认识的平台不猜：猜错会指向不存在的文件，报出来是「引擎没装」。
}

// 名片上的 `runtime.python` 落到可执行文件。{ok:false} 时 why 是给用户看的一句话。
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

// 把 `runtime.python` 这个声明变成可执行文件。
function resolveEnginePython (rootDirAbs, declared, platform) {
  const venvDir = path.resolve(rootDirAbs, declared)
  const r = venvPython(venvDir, platform)
  // 不支持的平台仍给一个形状正确的路径，让「解释器不存在」这条老报错继续成立。
  return r.ok ? r.python : path.join(venvDir, venvPythonRelPath('linux'))
}

module.exports = {
  venvPythonRelPath,
  venvPython,
  resolveEnginePython,
}
