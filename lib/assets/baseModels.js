// 底模在磁盘哪里：唯一的一处答案。模型只有两个来处：底模（引擎自己的一个全局位置，
// 名片 runtime.checkpoints 指明）和微调模型（角色资产目录下，由 modelLayout.js 管）。
// 底模来源无关：目录里躺着什么，平台就报什么；平台不问那是谁训的、怎么训的。
// 找法先细后粗：<底模目录>/<权重位名>/ 这一层存在 ⇒ 层内每一项是那个位的一个候选；
// 不存在 ⇒ 整个底模目录本身就是那个位的那一个候选（只在单权重位时成立）。

const fs = require('fs');
const path = require('path');

const { normalizeWeightSlots, toPosix, listDirEntries } = require('./modelLayout');
const { resolveCheckpointsDir } = require('../engines/checkpoints');
const { APP_DIR } = require('../paths');

// 引擎 id -> (ctx) => { <权重位名>: [ {name, path, ...}, ... ] }
// 覆盖钩子：某台引擎的底模不长通用的那个样子时，由知道内情的那一方登记自己的找法。
// 平台自己一条覆盖都不写。
const _overrides = new Map();

/** 登记一台引擎的底模找法。只有知道这台引擎底模长什么样的那一方才该调它。 */
function registerBaseModelSource(engineId, fn) {
  if (!engineId || typeof fn !== 'function') return;
  _overrides.set(String(engineId), fn);
}

/** 只给测试用：把登记表清空。 */
function _clearBaseModelSources() { _overrides.clear(); }

function statEntry(p, name) {
  let is_dir = false;
  let size_mb = null;
  try {
    const st = fs.statSync(p);
    is_dir = st.isDirectory();
    if (!is_dir) size_mb = Math.round(st.size / (1024 * 1024));
  } catch (_) { /* 报不出大小就不报，不因此让候选消失 */ }
  return { name, path: toPosix(p), is_dir, size_mb, builtin: true };
}

/**
 * 一台引擎的底模有哪些。
 * @param {object} profile resolveEngineProfile() 的返回体。需要它的
 * id / weight_slots / runtime.checkpoints（绝对路径）。
 * @returns {object} { <权重位名>: [候选...] }。位在但空 ⇒ 值是 []，不是缺键：
 * 「这个位一个候选都没有」和「没有这个位」是两件事，界面要能分开。
 */
function baseModelsForEngine(profile, ctx) {
  if (!profile) return {};
  const engineId = profile.id;
  const slots = Array.isArray(profile.weight_slots)
    ? profile.weight_slots
    : normalizeWeightSlots(profile.weights);
  if (slots.length === 0) return {};   // 这台引擎不需要用户选模型：合法

  const ov = _overrides.get(String(engineId));
  if (ov) {
    let got = null;
    try { got = ov(ctx || {}); } catch (_) { got = null; }
    const out = {};
    for (const s of slots) {
      out[s.name] = (got && Array.isArray(got[s.name])) ? got[s.name] : [];
    }
    // 登记过就到此为止，登记的找法失败了也不回退到通用规则：会来登记，
    // 正是因为这台引擎的底模不长通用的那个样子，这时候套通用规则得到的
    // 不是「少一点」，而是一个错的答案。报空至少是诚实的。
    return out;
  }

  // 底模目录的绝对路径不在这里算：名片写的是相对路径，而且可以被名片自己指定的
  // 环境变量顶掉（契约 §5）。唯一定义处是 lib/engines/checkpoints.js 的
  // resolveCheckpointsDir：在这里重算一遍，就是给「同一个事实两处写」再添一处。
  const ckDir = resolveCheckpointsDir(
    profile,
    (ctx && ctx.env) || process.env,
    (ctx && ctx.appDir) || APP_DIR,
  ).abs_path;
  const out = {};
  for (const s of slots) out[s.name] = [];
  if (!ckDir) return out;               // 名片没说底模在哪 ⇒ 报不出来，不是报错
  let dirExists = false;
  try { dirExists = fs.statSync(ckDir).isDirectory(); } catch (_) { dirExists = false; }
  if (!dirExists) return out;           // 还没下底模 ⇒ 空清单（界面另有「底模缺」的提示）

  for (const s of slots) {
    // 1) 先看有没有跟资产那侧一样的按位分层
    const perSlot = path.join(ckDir, s.name);
    let hasPerSlot = false;
    try { hasPerSlot = fs.statSync(perSlot).isDirectory(); } catch (_) { hasPerSlot = false; }
    if (hasPerSlot) {
      out[s.name] = listDirEntries(perSlot).map(e => ({ ...e, builtin: true }));
      continue;
    }
    // 2) 没有分层 ⇒ 整个底模目录就是这个位的那一个候选
    //  只在单权重位时成立。位不止一个却又没分层，说明名片说的和盘上放置不匹配：
    //  这时候把同一个目录报成两个位的候选是在撒谎，宁可报空。
    if (slots.length === 1) {
      out[s.name] = [statEntry(ckDir, path.basename(ckDir) || engineId)];
    }
  }
  return out;
}

/**
 * 所有已装引擎的底模，按引擎分组。
 * 形状跟角色资产那侧完全一致：{ <引擎id>: { <权重位>: [候选...] } }，
 * 界面把「底模」和「当前角色的微调模型」并成一个下拉时，两边不用各写一套拆包代码。
 */
function baseModelsByEngine(profiles, ctx) {
  const out = {};
  for (const p of (profiles || [])) {
    if (!p || !p.id) continue;
    const m = baseModelsForEngine(p, ctx);
    if (Object.keys(m).length) out[p.id] = m;
  }
  return out;
}

module.exports = {
  registerBaseModelSource,
  baseModelsForEngine,
  baseModelsByEngine,
  _clearBaseModelSources,
};
