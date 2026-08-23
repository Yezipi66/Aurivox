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

  // ⭐⭐ 第 1c 步加的体检。profile.js 把 maps / payload_keys / defaults 缺省成空，
  //   是为了让只关心地址和超时的调用方（换权重、健康检查）不必写全 —— 但对
  //   **真名片**来说，"空"就是静默回落：拼出来的请求体会少键，引擎那边表现成
  //   一句模糊的上游报错，或者更糟，静默用错默认值。所以现状测试盯死这一条。
  test(`真名片体检：${manifest.id} 写全了 maps（否则请求体会静默少键）`, () => {
    const profile = resolveEngineProfile(manifest.id, process.env)
    assert.equal(typeof profile.maps, 'object')
    assert.ok(profile.maps && !Array.isArray(profile.maps))
    assert.ok(profile.maps.text,
      `${manifest.id} 的名片没说「要合成的文本」在这台引擎那里叫什么键名（maps.text）—— ` +
      '缺了它连请求体的第一个键都拼不出来')
    // 映射的值必须是非空字符串。写 null / 不写 = 这台引擎没这个概念（合法）；
    // 映射到空串 = 说了等于没说，那是名片写坏了。
    for (const [k, v] of Object.entries(profile.maps)) {
      assert.equal(typeof v, 'string', `maps.${k} 必须是字符串（引擎的键名）`)
      assert.ok(v.length > 0, `maps.${k} 映射到了空串 —— 没有这个概念就整行不写，别写空`)
    }
    // 参考音频：名片说"必须有参考音频"，就必须同时说清楚它叫什么键名，
    // 否则平台会拦下没有参考音频的请求，却又发不出参考音频 —— 自相矛盾。
    if (profile.requires_reference_audio) {
      assert.ok(profile.maps.reference_audio,
        `${manifest.id} 声明 requires_reference_audio=true，却没有 maps.reference_audio`)
    }
  })

  test(`真名片体检：${manifest.id} 的 payload_keys / defaults 类型正确且不互相矛盾`, () => {
    const profile = resolveEngineProfile(manifest.id, process.env)
    assert.ok(Array.isArray(profile.payload_keys), 'payload_keys 必须是数组')
    for (const k of profile.payload_keys) {
      assert.equal(typeof k, 'string')
      assert.ok(k.length > 0)
    }
    assert.strictEqual(new Set(profile.payload_keys).size, profile.payload_keys.length,
      `${manifest.id} 的 payload_keys 里有重复项`)
    assert.ok(profile.defaults && typeof profile.defaults === 'object' && !Array.isArray(profile.defaults))
    // 默认值的键必须是这台引擎收得下的键 —— 否则平台会自动往请求体里塞一个
    // 引擎不认识的东西，而且每一次调用都塞。
    const mapped = new Set(Object.values(profile.maps))
    for (const k of Object.keys(profile.defaults)) {
      assert.ok(profile.payload_keys.includes(k) || mapped.has(k),
        `${manifest.id} 的 defaults.${k} 既不在 payload_keys 上，也不是任何一个平台词的映射目标 —— ` +
        '这个默认值会被无条件塞进每一次请求，引擎多半不认识它')
    }
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
