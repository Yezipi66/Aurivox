// ============================================================
//  advanced_params.json 是「界面记忆」—— 存的和读的必须是同一组键
// ============================================================
//
// ⚠ 这是一条**文本守卫**，不是行为测试。JSX 在这个仓库里跑不了单元测试
//   （没有 jsdom、也没有把 jsx 转译进 node --test），所以这里只能读源码。
//   它守不住语义，只守得住「有没有人把撤掉的东西又加回来、或者让存和读
//   再次错位」。真正的闸是 `cd web && npm run build` 加真机点一遍。
//
// 为什么值得写：2026-08-23 之前，这个组件**存 18 个键、读 7 个键**，中间
// 11 个只写不读。它们沉在 advanced_params.json 里，被当时的合并语义反复
// 拓印，最终把名片默认值（batch_size=4）永久压住 —— 而整件事没有一条测试会红。
//
// ⛔ 这里刻意**不写死那 7 个键的名字**去比对（那就又是一份会漂的参数表，
//    正是契约 C11 禁止的）。改为从源码里把「存的那一组」和「读的那一组」
//    各自抠出来，比对两个集合**相等** —— 规则式，不点名。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(HERE, 'GenerateTab.jsx'), 'utf-8')

/** 去掉 // 行注释和注释块，免得注释里提到的键名混进来。 */
function stripComments(s) {
  return s
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

const CODE = stripComments(SRC)

/** POST /api/advanced-params 时提交的那一组键。 */
function writtenKeys() {
  const i = CODE.indexOf("api('/api/advanced-params', {")
  assert.ok(i !== -1, '找不到回存 advanced-params 的调用')
  const after = CODE.slice(CODE.indexOf('body: {', i) + 'body: {'.length)
  const chunk = after.slice(0, after.indexOf('},'))
  // `temperature,` 这种简写和 `top_k: topK` 这种都要认。
  return new Set(
    chunk
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(':')[0].trim()),
  )
}

/** 挂载时从 GET /api/advanced-params 回填的那一组键。 */
function restoredKeys() {
  const i = CODE.indexOf("api('/api/advanced-params').then")
  assert.ok(i !== -1, '找不到挂载时读取 advanced-params 的 useEffect')
  const chunk = CODE.slice(i, CODE.indexOf('}, [])', i))
  const keys = new Set()
  for (const m of chunk.matchAll(/p\.([A-Za-z_][A-Za-z0-9_]*)\s*!==\s*undefined/g)) {
    keys.add(m[1])
  }
  assert.ok(keys.size > 0, '一个回填的键都没抠到，说明这条守卫的抓取规则已经失效')
  return keys
}

test('存进界面记忆的键，必须都读得回来 —— 不许再出现只写不读的沉积', () => {
  const read = restoredKeys()
  const written = writtenKeys()
  const writeOnly = [...written].filter((k) => !read.has(k))
  assert.deepEqual(
    writeOnly,
    [],
    `这些键存了却从不读回，会沉在 advanced_params.json 里压住名片默认值：${writeOnly.join(', ')}`,
  )
})

test('读得回来的键，也必须真的存过 —— 否则「记忆」是假的', () => {
  const read = restoredKeys()
  const written = writtenKeys()
  const readOnly = [...read].filter((k) => !written.has(k))
  assert.deepEqual(readOnly, [], `这些键会被读回却从没存过：${readOnly.join(', ')}`)
})

test('流式那三个格子没有被加回合成面板', () => {
  // 它们配的是 /v1/audio/speech 的行为，而这个界面消费不了流（runGenerate 等的是
  // audio_url）。要给端点配默认值，那是端点配置该干的事，不是合成格子。
  // ⚠ 撤的是界面格子，不是 API 能力 —— synthesisService 仍然解析这三个入参，
  //   第三方和 Flow 可以显式传（契约 §7 逃生门）。
  for (const gone of ['streamingMode', 'overlapLength', 'minChunkLength']) {
    assert.ok(
      !CODE.includes(gone),
      `${gone} 又回到 GenerateTab 了；如果这是有意的，请先给这个界面接上真的流式播放`,
    )
  }
})
