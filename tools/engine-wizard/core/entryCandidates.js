'use strict'

// 推理入口的候选清单：把这台引擎里的 Python 源文件摊开，供第 4 步下拉选择。
//
// 入口识别给不出结论时（证据不足、写法特殊），结论留空是诚实的做法；
// 但结论留空不该把使用者推向「对着空白格子回忆模块名」。这份清单把可选项摆出来，
// 每一项都带上写进 call.argv 需要的模块名，以及模块从哪个目录起算。
// 平台只提供选项，不替使用者挑：排序只是把证据强的放在前面。

const fs = require('node:fs')
const path = require('node:path')
const { findPyFiles, isNotEntryFile } = require('./pyFiles')
const { moduleWithRoot, scoreFile } = require('./entryPick')

/**
 * @param {string} dir 引擎源码根目录
 * @param {Array} params 扫描到的参数（按 source_file 归组打分）
 * @param {object} [opts]
 * @param {string[]} [opts.declaredModules] README 与打包声明点过名的模块
 * @param {string|null} [opts.recommended] 入口识别给出的文件
 * @returns {Array<{file, module, srcRoot, score, flags, groups, source, recommended}>}
 */
function buildEntryCandidates (dir, params, opts = {}) {
  if (!dir || !fs.existsSync(dir)) return []
  const srcIsPackage = fs.existsSync(path.join(dir, 'src', '__init__.py'))
  const byFile = new Map()
  for (const p of (params || [])) {
    if (!p || !p.source_file) continue
    if (!byFile.has(p.source_file)) byFile.set(p.source_file, [])
    byFile.get(p.source_file).push(p)
  }

  const rows = findPyFiles(dir)
    .filter((file) => !isNotEntryFile(file.split('/').pop()))
    .map((file) => {
      const list = byFile.get(file) || []
      const { module, srcRoot } = moduleWithRoot(file, { srcIsPackage })
      return {
        file,
        module,
        srcRoot,
        score: list.length ? scoreFile(file, list).score : 0,
        flags: list.length,
        groups: [...new Set(list.map((p) => p.group).filter((g) => g && g !== '(root)'))],
        source: 'file',
        recommended: false,
      }
    })

  // 打包声明里的模块名可能没有对应的源文件（例如装进环境的包）。
  //   它同样是使用者该能选的一项，列在清单里，不因为盘上找不到就丢掉。
  const known = new Set(rows.map((r) => r.module).filter(Boolean))
  for (const raw of (opts.declaredModules || [])) {
    const mod = String(raw || '').trim()
    if (!mod || known.has(mod)) continue
    known.add(mod)
    rows.push({
      file: null, module: mod, srcRoot: null, score: 4, flags: 0,
      groups: [], source: 'declared', recommended: false,
    })
  }

  const recommended = opts.recommended || null
  for (const r of rows) {
    r.recommended = !!(recommended && (r.file === recommended || r.module === recommended))
  }
  rows.sort((a, b) =>
    Number(b.recommended) - Number(a.recommended) ||
    b.score - a.score ||
    Number(b.source === 'declared') - Number(a.source === 'declared') ||
    String(a.file || a.module).localeCompare(String(b.file || b.module)))
  return rows
}

module.exports = { buildEntryCandidates }
