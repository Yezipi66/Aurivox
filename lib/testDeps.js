'use strict'
// 测试用的编译工具从哪儿解析：先根 node_modules（版本由根 package.json 钉住），再 web/node_modules。
// 选根那份：web 那份是 Vite 的传递依赖，跟着 Vite 升级漂；两份版本不同会解析出不同行为。

const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/** 从根 node_modules 解析一个包，根那份没有就退回 web 那份；都没有则返回 null。 */
function resolveFromRoot (name) {
  const candidates = [
    ROOT,
    path.join(ROOT, 'web'),
  ]
  for (const base of candidates) {
    try {
      return require.resolve(name, { paths: [base] })
    } catch (e) { /* 换下一个 */ }
  }
  return null
}

/**
 * @babel/parser 的 parse 函数。拿不到就抛，不返回 null：调用方的 try/catch 会把 null
 * 变成后面一句 parse(...) 的 TypeError，报错说的是「parse 不是函数」而不是「依赖没装」。
 */
function babelParse () {
  const p = resolveFromRoot('@babel/parser')
  if (!p) {
    throw new Error('拿不到 @babel/parser：根与 web/ 的 node_modules 里都没有它')
  }
  return require(p).parse
}

/** esbuild 模块。拿不到就抛，理由同 babelParse。 */
function esbuild () {
  const p = resolveFromRoot('esbuild')
  if (!p) {
    throw new Error('拿不到 esbuild：根与 web/ 的 node_modules 里都没有它')
  }
  return require(p)
}

module.exports = { resolveFromRoot, babelParse, esbuild, ROOT }
