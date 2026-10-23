'use strict';

const { slotFromMeta } = require('./modelLayout');

// 这个角色手上，那台引擎的每个权重位各该用哪一份：全仓库唯一一处。
// 三样东西全从名片来：engine.id、weight_slots[].name、weight_slots[].param。
// 本文件不写具体引擎 id 或位名，有守卫测试盯着。
// 没有 param 的位不发：悄悄发一个没人读的键比不发更糟，用户会以为换了而声音没变。
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
