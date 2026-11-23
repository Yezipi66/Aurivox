'use strict'

// 真名片体检：仓库里 engines/* 的名片必须能被读出来。
//
// 平台只判两种「不合法」：
//   (1) JSON 结构不合法（文件不是合法 JSON）——由 registry 读取时保证；
//   (2) 三节结构不合法（registration / invocation / acceptance 不是三节的形状）。
//
// 具体字段合不合法，平台没有能力、也不该判定：那是引擎自己的事，错了在第 5 步
//   出声时如实暴露。历史版本曾对 output_sample_rate / contract_version / runtime.* /
//   maps / payload_keys / upstream 等逐字段下断言，越界了，已删。
//
// 唯一保留的键级检查：legacy_default —— 那是「已经删掉的键」，留着会被下一个作者
//   抄走，属于结构卫生，不是字段合法性判断。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { listEngines } = require('./registry')
const { isV011, CONTRACT_VERSION } = require('./contract')

const engines = listEngines()

test('engines/ 下至少装了一台引擎（否则这个仓库合成不了任何东西）', () => {
  assert.ok(engines.length > 0, '一台都没找到；检查 ENGINES_DIR 是否正确')
})

for (const manifest of engines) {
  // (1) JSON 结构（解析不了会抛）＋ (2) 三节结构。
  test('真名片体检：' + manifest.id + ' 是合法 JSON 且为三节结构', () => {
    const raw = fs.readFileSync(path.join(manifest.dir, 'manifest.json'), 'utf8')
    const m = JSON.parse(raw)
    assert.ok(isV011(m),
      manifest.id + ' 不是三节结构（registration/invocation/acceptance）—— 契约版本是 ' + CONTRACT_VERSION)
  })
}

// 归零守卫：任何一张真名片都不许再写 legacy_default（结构卫生）。
test('⭐⭐⭐ 刀 A1: 没有任何一张真名片再写 legacy_default', () => {
  const offenders = engines
    .filter((m) => Object.prototype.hasOwnProperty.call(m, 'legacy_default'))
    .map((m) => m.id)
  assert.deepEqual(offenders, [],
    '这些名片还写着 legacy_default：' + offenders.join(', ') + '。\n' +
    '平台已经不读它了。留着 = 下一个作者会抄走它，然后查一天为什么不生效。')
})

test('⭐⭐ 刀 A1: engines/ 下的名片文件里一个 legacy_default 字样都搜不到（含注释键）', () => {
  const { ENGINES_DIR } = require('../paths')   // 不在 registry 里，在 paths 里
  const hits = []
  for (const m of engines) {
    const f = path.join(ENGINES_DIR, m.id, 'manifest.json')
    if (!fs.existsSync(f)) continue
    const src = fs.readFileSync(f, 'utf-8')
    // 盯的是键，不是字样："legacy_default":。不能盯字样：名片里特意留了一段墓碑
    //   注释（_comment_legacy_default_removed），那段散文里必然出现这个词。
    for (const line of src.split('\n')) {
      const key = /^\s*"([^"]+)"\s*:/.exec(line)
      if (!key) continue
      if (key[1].startsWith('_comment')) continue
      if (key[1] !== 'legacy_default') continue
      hits.push(m.id + ': ' + line.trim())
    }
  }
  assert.deepEqual(hits, [], '名片里还留着 legacy_default：\n' + hits.join('\n'))
})
