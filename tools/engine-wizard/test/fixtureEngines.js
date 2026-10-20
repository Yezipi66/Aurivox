'use strict'
// ============================================================================
//  测试用的夹具引擎目录
// ============================================================================
//
//  为什么需要它
//
//  干净检出（CI、别人的 clone）里 engines/ 只有 _TEMPLATE 与一张真名片。
//    而有一批测试守的是「多台引擎之间的关系」：
//      · 两台引擎的探活地址要不同（否则「有没有真读名片」这条断言钉不住任何东西）
//      · 两台引擎要各住各的 .venv（不许共用根环境）
//      · 「至少两台」本身是判据的一部分
//    这些断言在只有一张名片时无话可说，硬红则是假红。
//
//  机制
//
//  engines/ 的位置可由 ENGINES_DIR 改（lib/paths/engines.js 第 7 行，
//    与 lib/paths.js 是同一套覆盖口）。
//    ⇒ 测试把它指向本目录下的夹具引擎，那几组测试就能读到两台。
//
//  为什么夹具不放在 engines/ 下
//
//    engines/*/ 整棵树不进版本库（.gitignore 第 258 行），
//    而夹具必须进版本库 ⇒ 只能放在别处。
//
//  夹具的形状要求
//
//    · 用新写法 parameters[]（旧写法 param_keys/params/payload_keys
//      与它并存会被 registry 拒绝，见 lib/engines/parameterDeclaration.js:47）
//    · 两台的 ready_endpoint 必须不同（"/health" 与 "/ready"）
//    · 两台的 max_chars 必须不同（60 与 120）
//    · 一台要参考音频、一台不要（covers_reference_audio 这类分支）
// ============================================================================

const fs = require('node:fs')
const path = require('node:path')

/** 夹具引擎目录：tools/engine-wizard/test/fixtures/engines/ */
const FIXTURE_ENGINES_DIR = path.join(__dirname, 'fixtures', 'engines')

/**
 * 把 ENGINES_DIR 指到夹具目录。
 *
 * 必须在 require registry 之前调用：lib/paths/engines.js 在 require 时
 *   就把 ENGINES_DIR 定死了。
 *
 * @returns {string} 夹具目录的绝对路径
 */
function useFixtureEngines () {
  process.env.ENGINES_DIR = FIXTURE_ENGINES_DIR
  return FIXTURE_ENGINES_DIR
}

/**
 * 夹具目录里有哪些引擎 id。
 * 读的是盘上的目录，不写死：夹具增删时这里跟着变。
 */
function fixtureEngineIds () {
  let names = []
  try {
    names = fs.readdirSync(FIXTURE_ENGINES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (e) {
    return []
  }
  return names.filter((n) => !n.startsWith('_') && !n.startsWith('.'))
    .filter((n) => fs.existsSync(path.join(FIXTURE_ENGINES_DIR, n, 'manifest.json')))
}

module.exports = { FIXTURE_ENGINES_DIR, useFixtureEngines, fixtureEngineIds }
