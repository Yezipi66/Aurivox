'use strict'

// ---------------------------------------------------------------------------
//  真名片体检 —— 仓库里 engines/* 的名片必须真的能被解析
// ---------------------------------------------------------------------------
// profile.node.test.js 用的是临时目录里造的假名片，测的是**解析规则**。
// 本文件测的是**仓库现状**：engines/ 下每一张真名片，今天能不能读出来。
//
// 分成两个文件是有意的：
//   规则测试不该因为业务调了个 max_chars 就红；
//   现状测试不该锁死具体数值，否则同一件事要改两处。
// 所以下面**只判「读得出来、字段齐、类型对」，绝不断言具体数值**。
// 唯一的例外是 legacy_default 唯一性 —— 那不是数值，是不变量。

const test = require('node:test')
const assert = require('node:assert')

const { listEngines } = require('./registry')
const { resolveEngineProfile } = require('./profile')
const { findLegacyDefaultId } = require('./legacyDefault')

const engines = listEngines()

test('engines/ 下至少装了一台引擎（否则这个仓库合成不了任何东西）', () => {
  assert.ok(engines.length > 0, `一台都没找到；检查 ENGINES_DIR 是否正确`)
})

for (const manifest of engines) {
  test(`真名片体检：${manifest.id} 能被解析成引擎档案`, () => {
    let profile
    try {
      profile = resolveEngineProfile(manifest.id, process.env)
    } catch (err) {
      // 把名片校验的错误原样呈出来 —— 这类错误本身就写着「缺哪一行、去哪补」，
      // 包装成「测试失败」反而丢信息。
      assert.fail(`${manifest.id} 的名片读不出来：\n${err.message}`)
    }
    assert.equal(typeof profile.base_url, 'string')
    assert.match(profile.base_url, /^https?:\/\//, '地址要带协议头')
    assert.ok(Number.isInteger(profile.timeout_ms) && profile.timeout_ms > 0)
    assert.ok(Number.isInteger(profile.max_chars) && profile.max_chars > 0)
    assert.equal(profile.hard_max_chars, profile.max_chars * 2)
    assert.equal(typeof profile.hot_swap_models, 'boolean')
    assert.equal(typeof profile.requires_reference_audio, 'boolean')
    assert.equal(typeof profile.supports_finetune, 'boolean')
    assert.ok(Number.isInteger(profile.output_sample_rate) && profile.output_sample_rate > 0)
  })

  test(`真名片体检：${manifest.id} 声明了 contract_version 2`, () => {
    assert.equal(manifest.contract_version, 2,
      `${manifest.id} 的名片没写 contract_version:2 —— ` +
      '契约版本是给将来做兼容判断用的，缺了以后没法区分老名片和新名片')
  })
}

test('⭐ 有且只有一张真名片认领「老路径引擎」这个身份', () => {
  const id = findLegacyDefaultId(engines)
  assert.ok(engines.some((m) => m.id === id))
})

test('两台引擎不许监听同一个地址（否则合成会连错台且毫无提示）', () => {
  const seen = new Map()
  for (const m of engines) {
    const url = resolveEngineProfile(m.id, process.env).base_url
    if (seen.has(url)) {
      assert.fail(`引擎 ${seen.get(url)} 和 ${m.id} 的地址都是 ${url} —— ` +
        '两个进程不可能同时监听同一个端口，其中一台必然连错')
    }
    seen.set(url, m.id)
  }
})
