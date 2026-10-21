'use strict'
// 测试用的编译工具从哪儿来。
//
// 背景：@babel/parser 与 esbuild 原先只在 web/node_modules 里（Vite 的传递依赖），
//   测试却要 require 它们 ⇒ 根目录跑测试时必须先装 web 的依赖，
//   而 CI 上「先装 web 再跑根的测试」这个顺序没人记得住。
//
// 现在这两个包是根 package.json 的 devDependencies ⇒ 根 node_modules 里就有。
//   但 web/ 自己也有一份（Vite 要用），而 Node 的解析顺序是「近的先」：
//   从 web/src/ 起的测试会先撞上 web/node_modules 那份。
//   两份版本可能不同 ⇒ 解析出来的行为可能不同。
//
// 判据：解析出来的必须是**根**那一份（版本由根 package.json 锁死），
//   还是 web 那一份随 Vite 漂？⇒ 选根那份：
//   根 package.json 声明了版本，lock 锁得住；web 那份是 Vite 的传递依赖，
//   跟着 Vite 升级漂。
//
// 用法：
//   const { babelParse, esbuild } = require('../../lib/testDeps.js')

const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/**
 * 从根 node_modules 里解析一个包。
 * 根那份找不到时退回 web 那份（web 自己那份一定在，因为 web 的测试要它）。
 *
 * @param {string} name 包名
 * @returns {string|null} 解析到的绝对路径，取不到就是 null
 */
function resolveFromRoot (name) {
  const candidates = [
    ROOT,                                  // 根 node_modules（package.json 声明的那份）
    path.join(ROOT, 'web'),                // web/node_modules（Vite 的那份）
  ]
  for (const base of candidates) {
    try {
      return require.resolve(name, { paths: [base] })
    } catch (e) { /* 换下一个 */ }
  }
  return null
}

/**
 * @babel/parser 的 parse 函数。
 *
 * 拿不到就抛，不返回 null：调用方写的是 try/catch，
 *   返回 null 会变成后面一句 parse(...) 的 TypeError，
 *   报错说的是「parse 不是函数」而不是「依赖没装」。
 */
function babelParse () {
  const p = resolveFromRoot('@babel/parser')
  if (!p) {
    throw new Error('拿不到 @babel/parser：根与 web/ 的 node_modules 里都没有它')
  }
  return require(p).parse
}

/**
 * esbuild 模块。
 *
 * 拿不到就抛，理由同 babelParse。
 */
function esbuild () {
  const p = resolveFromRoot('esbuild')
  if (!p) {
    throw new Error('拿不到 esbuild：根与 web/ 的 node_modules 里都没有它')
  }
  return require(p)
}

module.exports = { resolveFromRoot, babelParse, esbuild, ROOT }
