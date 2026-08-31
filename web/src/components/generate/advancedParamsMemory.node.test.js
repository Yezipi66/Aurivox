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

/** 一段代码里**逐个点名**的键（spread 出来的那些不算，它们由名片决定）。 */
function namedKeys(chunk) {
  const keys = new Set()
  for (const raw of chunk.split(',')) {
    const s = raw.trim()
    if (!s || s.startsWith('...')) continue
    const head = s.split(':')[0].trim()
    // 只收看起来像标识符的（`temperature,` 简写和 `top_k: topK` 都算），
    // 表达式碎片（括号、箭头函数残片）一律跳过。
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(head)) keys.add(head)
  }
  return keys
}

/** POST /api/advanced-params 时**逐个点名**提交的那一组键。 */
function writtenKeys() {
  const i = CODE.indexOf("api('/api/advanced-params', {")
  assert.ok(i !== -1, '找不到回存 advanced-params 的调用')
  const after = CODE.slice(CODE.indexOf('body: {', i) + 'body: {'.length)
  const chunk = after.slice(0, after.indexOf('\n      }'))
  return namedKeys(chunk)
}

/**
 * ⭐ 刀 A1/A2（2026-08-31）：读取的地址从裸 `/api/advanced-params` 变成
 *   带 `?engine_id=` 的模板串，依赖数组从 `[]` 变成 `[engine?.id]`。
 *   ⇒ 这两个锚点跟着改。⛔ 不许改回去：后端不带 engine_id 就不回落到
 *     任何一台名片（pron.js:17-22），界面上表现为"格子全空、不报错"。
 */
const LOAD_ANCHOR = 'api(`/api/advanced-params?engine_id='

/** 从 GET /api/advanced-params 回填的那一组键。 */
function restoredKeys() {
  const i = CODE.indexOf(LOAD_ANCHOR)
  assert.ok(i !== -1, '找不到读取 advanced-params 的 useEffect（或者它又不带 engine_id 了）')
  const chunk = CODE.slice(i, CODE.indexOf('}, [engine?.id])', i))
  const keys = new Set()
  for (const m of chunk.matchAll(/p\.([A-Za-z_][A-Za-z0-9_]*)\s*!==\s*undefined/g)) {
    keys.add(m[1])
  }
  assert.ok(keys.size > 0, '一个回填的键都没抠到，说明这条守卫的抓取规则已经失效')
  return keys
}

// ⭐ 2026-08-29 起，这两条守卫守的形状变了 —— 原因值得写清楚。
//
// 引擎参数这一大半，现在两边都不再逐个点名：
//   存：paramValues 里**用户动过**的那些键
//   读：GET 回来的键里，**当前引擎名片有**的那些
// 也就是说「存的 ⊆ 名片」「读的 ⊆ 名片」，两个集合相等不再靠人肉对齐两张
// 列表，而是由构造保证 —— 这正是 2026-08-23 那个坑（存 18 读 7）的根治。
// ⛔ 但「逐个点名」的键还有（seed 就是一个，它不在任何名片里）。那部分仍然
//    会漂，所以这两条守卫继续守它们。

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

test('引擎参数两边都按名片走，⛔ 不许退回逐个点名', () => {
  // 这一条是上面两条的前提。一旦有人把 spread 改回一串写死的键名，
  // 上面两条会继续通过（两张列表可以抄得一模一样），却又回到了「靠人对齐」
  // 的老路 —— 而那正是 2026-08-23 那个坑的形状。
  const save = CODE.slice(CODE.indexOf("api('/api/advanced-params', {"))
  assert.ok(
    /\.\.\.Object\.fromEntries/.test(save.slice(0, 500)),
    '回存 advanced-params 时又开始逐个点名引擎参数了',
  )
  assert.ok(
    /touchedParams\.has/.test(save.slice(0, 500)),
    '回存时没有只挑用户动过的键 —— 没动过的键回存下去就把名片默认值抄死在盘上了',
  )
  const load = CODE.slice(CODE.indexOf(LOAD_ANCHOR))
  assert.ok(
    /param_schema/.test(load.slice(0, 800)),
    '挂载回填时没有按当前引擎的名片过滤 —— 换引擎后会把上一台的键灌进来',
  )
})

test('⭐⭐⭐ 读 advanced-params 必须带上 engine_id，且 engine 没到就不发', () => {
  const i = CODE.indexOf(LOAD_ANCHOR)
  assert.ok(i !== -1, '读取 advanced-params 时没带 engine_id')
  const before = CODE.slice(Math.max(0, i - 200), i)
  assert.ok(/if \(!engine\?\.id\) return/.test(before),
    'engine 还没加载就发请求了 —— 会拿到一份不属于任何引擎的空表')
  assert.ok(CODE.includes('}, [engine?.id])'),
    '依赖数组不是 [engine?.id] —— 换引擎后默认值不会重新问那张名片')
})

test('⛔ 存回去的必须只是用户动过的那些，不能是整份参数值', () => {
  // 整份回存 = 把名片默认值抄进盘上文件。之后名片改了也不生效，
  // 因为 loadAdvancedParams 是「盘上赢」（:460 那段实测）。
  const save = CODE.slice(CODE.indexOf("api('/api/advanced-params', {"), CODE.indexOf("api('/api/advanced-params', {") + 500)
  assert.ok(!/\.\.\.paramValues\b/.test(save), '整份 paramValues 被回存了')
})

test('⛔ 强制重推是平台开关，绝不许混进引擎参数表', () => {
  // advanced_params.json 是**引擎参数**的界面记忆。force_resynth 不是任何一台
  // 引擎的参数（一台引擎都没装它也有意义），混进去有两个具体后果：
  //   ① 它会沉进盘上文件，而 loadAdvancedParams 是「盘上赢」⇒ 变成所有调用方
  //      （含 /v1/audio/speech）的默认值，用户在别处根本没勾过；
  //   ② 一旦被当成引擎参数，它就会进 payload ⇒ 进缓存指纹 ⇒ 缓存全废。
  // 它该待的地方是浏览器本地（usePersistentState），那是纯界面偏好。
  assert.ok(
    !writtenKeys().has('force_resynth'),
    'force_resynth 被写进了 /api/advanced-params —— 它是平台开关，不是引擎参数',
  )
  assert.ok(
    CODE.includes("usePersistentState('generate.forceResynth'"),
    '强制重推的勾选状态必须持久化在浏览器本地（Owner 要求恢复上次设置）',
  )
  assert.ok(
    /force_resynth:\s*forceResynth/.test(CODE),
    '勾选状态必须真的进到 /api/generate 的请求体里，否则这个开关谁也管不着',
  )
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
