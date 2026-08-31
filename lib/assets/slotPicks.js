'use strict';

const { slotFromMeta } = require('./modelLayout');

// ---------------------------------------------------------------------------
//  「这个角色手上，那台引擎的每个权重位各该用哪一份」—— 全仓库唯一一处
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 刀 A2（2026-08-31）从 lib/routes/synthesis.js 抽出来的。
//
// ## 抽出来的理由（⛔ 不是"整洁"）
//
// 抽之前那段循环写在 `/api/generate` 的中段，**只能靠一次真合成来验**。
// 而今天盘上只有 GPT-SoVITS 一台带权重位的引擎 ⇒ 写死 `"gpt-sovits"` 和
// 不写死，跑出来一模一样。⇒ **不抽出来，A2 就没有任何一条测试能证明它做了事。**
//
// ⭐ 判据：一刀如果只能靠"盘上恰好只有一台"来通过，那它没被验过。
//
// ## 三样东西全从名片来，⛔ 平台不认识任何一台引擎
//
// | 要什么 | 从哪来 |
// |---|---|
// | 哪台引擎 | `engine.id`（本次请求点名的那台） |
// | 有几个位、各叫什么 | `engine.weight_slots[].name` |
// | 选中的那份用哪个键发出去 | `engine.weight_slots[].param` |
//
// ## 禁令
//
// ⛔ **没有 `param` 的位不发。** 名片不写 `param` 的含义是
//   「这台引擎运行中换不了权重」（`modelLayout.js:227-233`）。界面照样列候选
//   （能不能换 ≠ 有没有），但那个选择⛔不发出去 —— 悄悄发一个没人读的键
//   是撒谎，比不发还糟：用户以为换了，声音没变，查不到原因。
// ⛔ 不许在本文件出现任何一台引擎的 id 或位名。同目录的
//   `slotPicks.node.test.js` 有一条守卫盯着这一行。
//
// ## 预言（可证伪）
//
// 两台引擎的名片把 `param` 写成同一个字符串时（比如都叫 `"model"`），
// 这个函数没问题（一次只服务一台）。出问题的是**配方**：它今天只有一层
// 参数格子。⇒ 那一天要做的是让配方按引擎分格，⛔ 不是在这里加去重。

/**
 * @param {{id: string, weight_slots?: Array<{name?: string, param?: string}>}} engine
 *        本次请求点名的那台引擎（已解析的名片）
 * @param {object} meta  角色的 meta.json（`assets.models[<engineId>][<slot>]` 形状）
 * @param {(list: Array) => (object|null)} pickBest  从候选里挑一份（平台的既有排序）
 * @returns {Record<string, string>} 按名片声明的 `param` 名索引的路径表。
 *          ⚠ 挑不到的位**整个键都不出现**，⛔ 不是空串 ——
 *            两者在下游等价（`payload.js:63` 的 `isSendable`
 *            对 `undefined` 和 `''` 都返回 false），但"不存在"更诚实。
 */
function pickSlotWeights(engine, meta, pickBest) {
  const picks = {};
  if (!engine || !meta) return picks;
  for (const slot of (engine.weight_slots || [])) {
    if (!slot || !slot.name || !slot.param) continue;
    const list = slotFromMeta(meta, engine.id, slot.name);
    if (!Array.isArray(list) || list.length === 0) continue;
    const best = pickBest(list) || {};
    if (best.path) picks[slot.param] = best.path;
  }
  return picks;
}

module.exports = { pickSlotWeights };
