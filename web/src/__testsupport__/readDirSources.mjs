// 读源码守卫的共享辅助：读「一个组件目录下的全部源码」。
//
// 这些守卫做的是「源码里有没有某个字面串」的判断（JSX 在这个仓库里没法通过单测：
// node --test 不经 vite，也没有 jsdom）。组件会按功能拆成同目录下的几个文件，只读
// 原来那一个文件的守卫就看不见拆出去的部分：守卫会静默失效（断言的字面串搬到了兄弟
// 文件里，它无法读取，于是「没找到」和「确实没有」读数相同）。
//
// 做法：读一个目录（默认不递归）下所有 .js/.jsx/.mjs，排除 .test.* 和 .bak，
// 按文件名排序后拼接，守卫的断言因此覆盖整个组件目录。
// 用法：readDirSources(import.meta.url, '.') 读本目录，'..' 读上级目录。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 拼接一个目录下的全部源码（默认不递归）。 */
export function readDirSources (fromUrl, relDir = '.', opts = {}) {
  const here = path.dirname(fileURLToPath(fromUrl))
  const dir = path.resolve(here, relDir)
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
export function stripComments (src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')   // JSX 注释
    .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}
