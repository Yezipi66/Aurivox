// 底模在磁盘哪里：唯一的一处答案。模型只有两个来处：底模（引擎自己的一个全局位置，
// 名片 runtime.checkpoints 指明）和微调模型（角色资产目录下，由 modelLayout.js 管）。
// 底模来源无关：目录里躺着什么，平台就报什么，不问那是谁训的、怎么训的。
// 找法先细后粗：先看有没有按权重位分层的子目录，没有就把整个底模目录当成那一个候选。

const fs = require('fs');
const path = require('path');

const { normalizeWeightSlots, toPosix, listDirEntries } = require('./modelLayout');
const { resolveCheckpointsDir } = require('../engines/checkpoints');
const { APP_DIR } = require('../paths');

// 引擎 id -> (ctx) => { <权重位名>: [ {name, path, ...}, ... ] }
// 覆盖钩子：某台引擎的底模不长通用的那个样子时，由知道内情的那一方登记自己的找法（平台自己一条都不写）。
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

/** 一台引擎的底模有哪些。
 *  @param {object} profile resolveEngineProfile() 的返回体（取 id / weight_slots / runtime.checkpoints）。
 *  @returns {object} { <权重位名>: [候选...] }：位在但空 ⇒ 值是 []，不是缺键（界面要能分开这两件事）。 */
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
    // 登记过就到此为止，登记的找法失败了也不回退到通用规则：套通用规则得到的不是「少一点」的答案，而是一个错的答案。
    return out;
  }

  // 底模目录的绝对路径不在这里算：名片写的是相对路径，且可被名片自己指定的环境变量顶掉。
  // 唯一定义处是 lib/engines/checkpoints.js 的 resolveCheckpointsDir。
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
    const perSlot = path.join(ckDir, s.name);
    let hasPerSlot = false;
    try { hasPerSlot = fs.statSync(perSlot).isDirectory(); } catch (_) { hasPerSlot = false; }
    if (hasPerSlot) {
      out[s.name] = listDirEntries(perSlot).map(e => ({ ...e, builtin: true }));
      continue;
    }
    // 没有按位分层 ⇒ 整个底模目录就是这个位的那一个候选，只在单权重位时成立；位不止一个却又没分层，说明名片说的和盘上放置不匹配，宁可报空也不把同一个目录报成两个位的候选。
    if (slots.length === 1) {
      out[s.name] = [statEntry(ckDir, path.basename(ckDir) || engineId)];
    }
  }
  return out;
}

/** 所有已装引擎的底模，按引擎分组。形状跟角色资产那侧完全一致：{ <引擎id>: { <权重位>: [候选...] } }，
 *  两边并成一个下拉时不用各写一套拆包代码。 */
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
