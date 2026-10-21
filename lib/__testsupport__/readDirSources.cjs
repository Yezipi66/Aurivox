'use strict'
// 读源码守卫的共享辅助（CommonJS 版）：读一个组件目录下的全部源码。
// 守卫做的是「源码里有没有某个字面串」的判断，而组件会拆成同目录下的几个文件，
// 只读其中一个会让守卫看不见拆出去的部分，守卫静默失效。
// 读一个目录（默认不递归）下所有 .js/.jsx，排除 .test.* 与 .bak，按文件名排序后拼接。

const fs = require('node:fs')
const path = require('node:path')

/** 拼接一个目录下的全部源码（默认不递归）。 */
function readDirSources (dir, opts = {}) {
  const recursive = !!opts.recursive
  const files = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (recursive && e.name !== 'node_modules') walk(p)
        continue
      }
      if (!/\.(jsx?|mjs)$/.test(e.name)) continue
      if (/\.test\./.test(e.name)) continue
      if (/\.bak$/.test(e.name)) continue
      files.push(p)
    }
  }
  walk(dir)
  files.sort()
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
}

/** 去掉注释，只留代码。 */
function stripComments (src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

module.exports = { readDirSources, stripComments }
