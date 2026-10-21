'use strict'

// 测试用的夹具引擎目录，让「多台引擎之间的关系」这类断言在任何机器上都成立。
// 挂在 registry 的附加目录上，真名片原封不动：名片里的相对路径按「名片所在目录」与
// 「项目根」两种基准解析，搬走会让两者不再一致。
/** 挂上夹具引擎目录，返回它的绝对路径。必须在 require registry 之前调用。 */

const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const FIXTURE_ENGINES_DIR = path.join(
  REPO_ROOT, 'tools', 'engine-wizard', 'test', 'fixtures', 'engines')

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
