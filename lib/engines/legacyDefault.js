'use strict'

// ---------------------------------------------------------------------------
//  老路径引擎 —— 一个**过渡期**概念，第 2 步结束后应当删除
// ---------------------------------------------------------------------------
// 背景：webui 那条老合成路径（server.js → routes/synthesis.js →
// services/synthesisService.js → gsv/client.js）从来没有「引擎」这个参数。
// 它诞生时全世界只有一台引擎，所以「连哪台」是个模块级常量。
//
// 第 1 步要把那个常量拔掉，但又不能顺手给老路径加一个引擎参数（那是第 2 步，
// 要动 adapter 和 service 的签名）。中间这段时间，得有个东西回答：
//
//     「没人告诉我连哪台的时候，连哪台？」
//
// 答案不写在代码里，写在名片上：**哪张名片写了 legacy_default:true，就是它**。
// 这样 lib/ 里依然没有任何引擎的名字，而「老路径今天绑死在谁身上」这件事
// 变成一个看得见、可以被审计、将来可以被删除的事实，而不是一个藏在
// 第 10 行字符串里的默认值。
//
// ⚠ 删除条件（2026-08-28 订正为今天的真话）：
//
//     **当 web 前端开始发 engine_id 时**，本文件连同名片里的 legacy_default
//     一起删。
//
//   原来这里写的是「当合成路径的每一次调用都自带 engine_id 时」。那句话现在
//   会误导人去数调用点：契约 §12 第 2 步已经让 broker（`/v1/audio/speech`）与
//   flow 画布（`flowgraph/adapter.js`）两条路都**强制**带 engine_id 了，
//   照那句话读，今天就该能删 —— 删不掉。
//
//   删不掉的原因只有一个，且只剩一个：**webui 是最后一个不发 engine_id 的
//   调用方**（`/api/generate` → `services/synthesisService.js`，Owner 明确
//   拍板这一轮不动前端）。所以真正的删除条件不是「调用点数到零」，是
//   「前端那条线接上」。这是刀 2 的事。
//
//   ⚠ 删的时候不是只删这个文件 —— 下面这些消费者要一起处理，否则删了就是
//     一片 MODULE_NOT_FOUND：
//       services/synthesisService.js  webui 缺 engine_id 时的认领（**病根本身**）
//       routes/synthesis.js           老配方 v<4 没记引擎，替它认领
//       routes/voices.js              参数格子的默认值取自哪台
//       recipeStore.js                同上，两处
//       gsv/client.js                 不传 baseUrl 时连哪台
//     （`flowgraph/adapter.js` 曾经也在这张表上，已于本刀移除 —— 那是第一个
//      被摘掉的消费者，摘一个划掉一行。）
//
//   legacyDefault.node.test.js 里有一条测试盯着「有且只有一张名片认领这个
//   身份」—— 第二张一旦出现，会立刻红，而不是变成「看谁排前面」的静默竞态。

const { listEngines } = require('./registry')
const { resolveEngineProfile } = require('./profile')

function legacyError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

/** 找出认领「老路径引擎」身份的那张名片，返回它的 id。 */
function findLegacyDefaultId(engines = listEngines()) {
  const claimed = engines.filter((m) => m.legacy_default === true)
  if (claimed.length === 1) return claimed[0].id

  if (claimed.length === 0) {
    throw legacyError('ENGINE_LEGACY_DEFAULT_MISSING',
      '没有任何引擎 manifest.json 写了 legacy_default:true —— 老合成路径不知道该连哪台引擎。' +
      `（当前已装：${engines.map((m) => m.id).join('、') || '一台都没有'}）` +
      '请在承担这个角色的引擎的 manifest.json 里加上 "legacy_default": true。',
      { available: engines.map((m) => m.id) })
  }
  // 两张都认领 ⇒ 必须响。静默取第一个，等于让「连到了哪台」取决于目录名的
  // 字母序，而这件事没有任何人会去检查。
  throw legacyError('ENGINE_LEGACY_DEFAULT_AMBIGUOUS',
    `有 ${claimed.length} 张引擎 manifest.json 都写了 legacy_default:true（${claimed.map((m) => m.id).join('、')}）—— ` +
    '这个身份只能有一个，否则「老路径连到了哪台」将取决于目录的字母序。' +
    '请只保留一个。',
    { claimed: claimed.map((m) => m.id) })
}

/** 老路径要用的引擎档案。地址、超时都从这里来。 */
function resolveLegacyDefaultProfile(env = process.env) {
  return resolveEngineProfile(findLegacyDefaultId(), env)
}

module.exports = { findLegacyDefaultId, resolveLegacyDefaultProfile }
