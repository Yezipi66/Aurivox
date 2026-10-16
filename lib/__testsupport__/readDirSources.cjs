'use strict'
// ===========================================================================
//  读源码守卫的共享辅助（CommonJS 版）：读「一个组件目录下的全部源码」
// ===========================================================================
//
// 与 web/src/__testsupport__/readDirSources.mjs 同一件事，只是这边是
// CommonJS（lib/ 下的 .node.test.js 用 require）。
//
// 为什么需要它：这些守卫做的是「源码里有没有某个字面串」的判断（JSX 在这个
// 仓库中无法通过单测执行：node --test 不经 vite，也没有 jsdom）。原本每个守卫各自
// readFileSync 一个 .jsx 文件。
//
//  但组件会拆分：一个大文件按功能拆成同目录下的几个文件之后，只读原来那
//  一个文件的守卫就看不见拆出去的部分了，守卫会静默失效（断言的字面串搬
//  到了兄弟文件里，它无法读取，于是「没找到」和「确实没有」读数相同）。
//
// 做法：读一个目录（默认不递归）下所有 .js/.jsx，排除 .test.* 和 .bak，
// 按文件名排序后拼接。守卫的断言因此覆盖整个组件目录。

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

/** 去掉注释，只留代码（JSX 注释 / 块注释 / 整行 // 注释）。 */
function stripComments (src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

module.exports = { readDirSources, stripComments }
