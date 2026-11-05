'use strict'

// 引擎目录里的 Python 源文件清单。
//
// 只列 .py：命令行入口不会是别的文件类型，包装脚本不需要平台替使用者判断。
// 不设目录层级上限：上游把入口放在 src/ 下若干层是常见的工程布局，层数限死
//   会让那些文件从候选里消失，界面上连「为什么没找到」都说不出来。
// 明确不构成入口的目录与文件名在这里剔除；其余一律列出来交给使用者选，
//   平台不按文件名猜哪一个是推理入口。

const fs = require('node:fs')
const path = require('node:path')

// 依赖目录、构建产物与文档目录：这些目录里的 .py 不是这台引擎的推理入口，
//   列进候选只会把下拉框淹没。点开头的目录一并跳过（虚拟环境、缓存、编辑器配置）。
const SKIP_DIRS = Object.freeze(new Set([
  'node_modules', '__pycache__', '.venv', 'venv', 'env', '.env', 'site-packages',
  'build', 'dist', 'docs', 'doc', 'tests', 'test', 'testing',
  'examples', 'notebooks', 'assets', 'static', 'wheels',
  '.git', '.github', '.idea', '.vscode', '.tox', '.eggs',
  '.mypy_cache', '.pytest_cache', '.ruff_cache',
]))

// 包初始化、安装脚本、测试与生成文件：它们不会有可执行的命令行入口。
const SKIP_FILE_RE = /^(?:__init__|setup|setup_[^/]*|conftest|noxfile)\.py$|^test_.*\.py$|^.*_test\.py$|^.*\.pb2\.py$/i

// 网页界面与启动包装：它们是入口的调用者，不是命令行入口本身。
// 只从下拉候选里剔除，扫描仍会读到它们；输入框允许直接输入，能力不会被拿走。
const NOT_ENTRY_RE = /^(?:webui|app|gradio(?:_app)?|launch|demo)\.py$/i

function isSkippedFile (name) { return SKIP_FILE_RE.test(name) }
function isSkippedDir (name) { return SKIP_DIRS.has(name) || name.startsWith('.') }
function isNotEntryFile (name) { return NOT_ENTRY_RE.test(name) }

/**
 * 递归列出目录里的全部 Python 源文件，返回正斜杠的相对路径。
 * 不设深度上限；只按目录名与文件名剔除明确无关的部分。
 *
 * @param {string} dir 引擎源码根目录
 * @param {{skipFile?: Function, skipDir?: Function}} [opts]
 * @returns {string[]}
 */
function findPyFiles (dir, opts = {}) {
  if (!dir || !fs.existsSync(dir)) return []
  const skipFile = opts.skipFile || isSkippedFile
  const skipDir = opts.skipDir || isSkippedDir
  const out = []
  const walk = (rel) => {
    const full = rel ? path.join(dir, ...rel.split('/')) : dir
    let entries
    try { entries = fs.readdirSync(full, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (skipDir(e.name)) continue
        walk(childRel)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.py')) {
        if (skipFile(e.name)) continue
        out.push(childRel)
      }
    }
  }
  walk('')
  return out.sort((a, b) => a.localeCompare(b))
}

module.exports = { findPyFiles, isSkippedFile, isSkippedDir, isNotEntryFile, SKIP_DIRS, SKIP_FILE_RE }
