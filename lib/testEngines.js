'use strict'
// ============================================================================
//  测试用的额外引擎目录（夹具）
// ============================================================================
//
//  为什么需要它
//
//  有一批测试守的是「多台引擎之间的关系」：
//    · 两台引擎的探活地址要不同（否则「有没有真读名片」这条断言钉不住任何东西）
//    · 两台引擎要各住各的 .venv（不许共用根环境）
//    · 「至少两台」本身是判据的一部分
//
//  这些断言在「只有一张名片」的机器上无话可说：
//  干净检出（CI、别人的 clone）里 engines/ 只有 _TEMPLATE 与一张真名片。
//
//  为什么不把真名片搬进临时目录
//
//  名片里写的是相对路径：runtime.entry 相对「名片所在目录」解析，
//  runtime.python / checkpoints 相对「项目根」解析。
//  把真名片拷到临时目录 ⇒ entry 解到临时目录，python 解到项目根，
//  两者不再是一套 ⇒ 「黄金样本：启动计划逐字等于搬家前」那条直接红。
//
//  ⇒ 改用「附加目录」：真 engines/ 原封不动，
//  夹具目录挂在旁边（lib/engines/registry.js 的 AURIVOX_EXTRA_ENGINES_DIR）。
//  判据强度不降：真名片一台不少，另外多两台。
//
//  用法：
//    const { useFixtureEngines } = require('../../lib/testEngines.js')
//    useFixtureEngines()                  // 必须在 require registry 之前
//    const { listEngines } = require('./registry')
// ============================================================================

const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const FIXTURE_ENGINES_DIR = path.join(
  REPO_ROOT, 'tools', 'engine-wizard', 'test', 'fixtures', 'engines')

/**
 * 把夹具引擎目录挂到 registry 的附加目录上。
 *
 * 必须在 require registry 之前调用：registry.js 在 require 时
 *   就把附加目录定死了。
 *
 * @returns {string} 夹具目录的绝对路径
 */
function useFixtureEngines () {
  const existing = process.env.AURIVOX_EXTRA_ENGINES_DIR
  const dirs = existing
    ? existing.split(path.delimiter).filter(Boolean)
    : []
  if (!dirs.includes(FIXTURE_ENGINES_DIR)) dirs.push(FIXTURE_ENGINES_DIR)
  process.env.AURIVOX_EXTRA_ENGINES_DIR = dirs.join(path.delimiter)
  return FIXTURE_ENGINES_DIR
}

module.exports = { useFixtureEngines, FIXTURE_ENGINES_DIR }
