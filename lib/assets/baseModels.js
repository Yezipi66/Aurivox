// lib/assets/baseModels.js
// ---------------------------------------------------------------------------
//  底模在磁盘哪里 —— 唯一的一处答案
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 模型只有两个来处，而且穷尽（Owner 2026-08-30 定案）：
//
//    ┌──────────┬──────────────────────┬──────────────────────────────┐
//    │ 底模     │ 引擎自己的一个全局位置 │ 官方发布 / 社区微调 / 用户手放 │
//    │ 微调模型 │ 角色资产目录下         │ 训练管线「接入」进来的        │
//    └──────────┴──────────────────────┴──────────────────────────────┘
//
//    lib/assets/modelLayout.js 管**下面**那一栏（角色资产目录下的）。
//    **这个文件管上面那一栏。**
//
// ⛔⛔ 这个文件存在的直接原因，是那个把整件事炸出来的错：
//    我曾经因为「IndexTTS2 没有官方微调路径」就推出「它永远产不出模型、
//    在有哪些模型可用的清单里一个入口都没有」。
//    ⇒ 这是拿「**怎么生产它**」定义「**它存不存在**」。
//    社区自己微调一版扔进那个目录，它就是一个模型，跟我们有没有训练管线无关。
//
//    ⭐ 所以这里的规矩只有一条：**底模一栏来源无关**。
//      目录里躺着什么，平台就报什么；平台永远不问那是谁训的、怎么训的。
//
// ── 怎么找 ──────────────────────────────────────────────────────────────
//
//  名片给两样东西：
//    · 底模目录     runtime.checkpoints（每台引擎都有，契约 §5 必填）
//    · 要挑几份权重 weights（本次新增，见 §5「我的模型怎么找」）
//
//  然后按这个顺序找（**先细后粗**，第一个命中就用它）：
//
//    1) <底模目录>/<权重位名>/     —— 跟角色资产里一模一样的分层。
//         有这一层 ⇒ 里面每一项都是这个位的一个候选。
//         ⭐ 这条给「一台引擎的底模有好几份、还会不断加」的情况留了门：
//           用户往这个目录里扔一份社区微调的权重，立刻就出现在下拉里，
//           不用改一行代码、不用改名片。
//
//    2) 找不到那一层 ⇒ **整个底模目录本身就是这个位的那一个候选**。
//         ⭐ 这条覆盖「底模是一整套文件、不是单个权重」的引擎
//           （IndexTTS2 就是：config.yaml + bpe.model + gpt.pth + s2mel.pth …
//           一整个目录才是一个模型，拆开来任何一个文件都不是）。
//
//  ⛔ 平台**不筛后缀**、**不读文件头**、**不认识任何引擎名**。
//     一个候选可以是一个文件，也可以是一整个目录 —— 跟资产那一侧同一条规矩。
//
// ── 覆盖钩子 ────────────────────────────────────────────────────────────
//
//  ⚠ 有一台引擎的底模不长这样：GPT-SoVITS 的官方权重散落在上游自己规定的
//    子路径里（s1 一个地方、s2 好几个版本各一个地方），既不分权重位子目录，
//    也不是「整个目录是一份模型」。那套路径知识今天住在 server.js 里。
//
//  ⭐ 所以留一个**登记式**的覆盖钩子：谁知道自己的底模长什么样，谁把答案
//    登记进来。⛔ 注意这不是给平台开的后门 —— 平台自己一条覆盖都不写，
//    这张表在平台启动时是**空的**，由知情的那一方（今天是 server.js 里
//    GPT-SoVITS 那段既有代码）自己登记。
//
//  ⚠ 这仍是一笔挂着的账：正确的归宿是「像浏览器插件那样的扩展机制」
//    （Owner 2026-08-30：那个现在不做）。这个钩子是那件事到来之前的落脚点，
//    它把一台引擎的私货**收进一个地方**，而不是撒在五个文件里。

const fs = require('fs');
const path = require('path');

const { normalizeWeightSlots, toPosix, listDirEntries } = require('./modelLayout');
const { resolveCheckpointsDir } = require('../engines/checkpoints');
const { APP_DIR } = require('../paths');

// engineId -> (ctx) => { <权重位名>: [ {name, path, ...}, ... ] }
const _overrides = new Map();

/**
 * 登记一台引擎的底模找法。
 * ⛔ 只有**知道这台引擎底模长什么样的那一方**才该调它。平台自己不调。
 */
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
  } catch (_) { /* 报不出大小就不报，⛔ 不因此让候选消失 */ }
  return { name, path: toPosix(p), is_dir, size_mb, builtin: true };
}

/**
 * 一台引擎的底模有哪些。
 *
 * @param {object} profile  resolveEngineProfile() 的返回体。需要它的
 *                          id / weight_slots / runtime.checkpoints（绝对路径）。
 * @returns {object} { <权重位名>: [候选...] }。⚠ 位在但空 ⇒ 值是 []，
 *                   **不是缺键** —— 「这个位一个候选都没有」和「没有这个位」
 *                   是两件事，界面要能分开。
 */
function baseModelsForEngine(profile, ctx) {
  if (!profile) return {};
  const engineId = profile.id;
  const slots = Array.isArray(profile.weight_slots)
    ? profile.weight_slots
    : normalizeWeightSlots(profile.weights);
  if (slots.length === 0) return {};   // 这台引擎不需要用户选模型 —— 合法

  const ov = _overrides.get(String(engineId));
  if (ov) {
    let got = null;
    try { got = ov(ctx || {}); } catch (_) { got = null; }
    const out = {};
    for (const s of slots) {
      out[s.name] = (got && Array.isArray(got[s.name])) ? got[s.name] : [];
    }
    // ⭐ 登记过就**到此为止**，登记的找法失败了也不回退到通用规则。
    //   会来登记，正是因为这台引擎的底模不长通用的那个样子 ——
    //   这时候套通用规则，得到的不是"少一点"，而是**一个错的答案**
    //   （比如把整个底模目录报成一份根本装不进这个位的模型）。
    //   ⛔ 报空至少是诚实的，而且界面另有「底模缺」的提示会说话。
    return out;
  }

  // ⭐ 底模目录的绝对路径**不在这里算**：名片写的是相对路径，而且可以被名片
  //   自己指定的环境变量顶掉（契约 §5）。那套规矩的唯一定义处是
  //   lib/engines/checkpoints.js:resolveCheckpointsDir —— 在这里重算一遍，
  //   就是给「同一个事实两处写」再添一处。
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
    //    ⚠ 只在**单权重位**时成立。位不止一个却又没分层，说明名片说的和盘上
    //      放的对不上 —— 这时候把同一个目录报成两个位的候选是**在撒谎**，
    //      宁可报空，让「底模缺」的提示去说话。
    if (slots.length === 1) {
      out[s.name] = [statEntry(ckDir, path.basename(ckDir) || engineId)];
    }
  }
  return out;
}

/**
 * 所有已装引擎的底模，按引擎分组。
 * 形状跟角色资产那侧**完全一致**：{ <引擎id>: { <权重位>: [候选...] } }
 * ⭐ 一致是有意的：界面把「底模」和「当前角色的微调模型」并成一个下拉时，
 *   两边不用各写一套拆包代码。
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
