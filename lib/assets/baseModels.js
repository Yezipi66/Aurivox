// 底模在磁盘哪里、有哪些。模型只有两个来处：底模（引擎自己的一个全局位置，
// 名片 runtime.checkpoints 指明）和微调模型（角色资产目录下，由 modelLayout.js 管）。
// 有哪些候选先细后粗：引擎在 scan.json 里声明了 base_models 就只报声明过的那几个文件，
// 没声明才按目录看：底模目录下按权重位分目录，或整个目录算一份模型。
// 声明过的那台，用户手动放进目录的权重不算候选：底模下拉要的是「这台引擎认这几份官方权重」。

const fs = require('fs');
const path = require('path');

const { normalizeWeightSlots, toPosix, listDirEntries } = require('./modelLayout');
const { resolveCheckpointsDir } = require('../engines/checkpoints');
const { readScanStatus, scanError } = require('../assetScanner/engineScan');
const { APP_DIR } = require('../paths');

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

function firstExisting(ckDir, candidates) {
  for (const rel of candidates) {
    if (fs.existsSync(path.join(ckDir, rel))) return path.join(ckDir, rel);
  }
  return null;
}

/** 引擎在 scan.json 里声明的底模候选，按声明的顺序填进各个位。
 *  位写错（名片里没这个位）是配置错误，不是「少一条候选」：报出来让人去改，不静默丢。 */
function declaredBaseModels(engineId, file, entries, ckDir, out) {
  for (const entry of entries) {
    if (!Object.prototype.hasOwnProperty.call(out, entry.slot)) {
      throw scanError(
        `引擎 ${engineId} 的 ${file} 里 base_models 给位 ${JSON.stringify(entry.slot)} 声明了候选，` +
        `但名片的 weights 里没有这个位（现有的位：${Object.keys(out).join(' / ') || '无'}）：` +
        '改 scan.json 的 slot，或在名片里补上这个位。',
        { engine_id: engineId, file, key: 'base_models', value: entry.slot })
    }
    const fp = firstExisting(ckDir, entry.candidates);
    if (!fp) continue;
    const item = { name: entry.name, path: toPosix(fp) };
    if (Object.prototype.hasOwnProperty.call(entry, 'steps')) item.steps = entry.steps;
    if (entry.version !== undefined) item.version = entry.version;
    item.builtin = true;
    item.default = entry.default === true;
    out[entry.slot].push(item);
  }
  return out;
}

/** 一台引擎的底模有哪些。
 *  @param {object} profile resolveEngineProfile() 的返回体（取 id / weight_slots / runtime.checkpoints）。
 *  @param {object} ctx  { env, appDir }：测试用，默认 process.env / APP_DIR。
 *  @param {object} [status] readScanStatus() 的返回体；批量调的场合由调用方读一次传进来。
 *  @returns {object} { <权重位名>: [候选...] }：位在但空 ⇒ 值是 []，不是缺键（界面要能分开这两件事）。 */
function baseModelsForEngine(profile, ctx, status) {
  if (!profile) return {};
  const slots = Array.isArray(profile.weight_slots)
    ? profile.weight_slots
    : normalizeWeightSlots(profile.weights);
  const out = {};
  for (const s of slots) out[s.name] = [];
  if (slots.length === 0) return {};   // 这台引擎不需要用户选模型：合法

  const { conventions: conv, file } = status || readScanStatus(profile.id);
  const ckDir = ckDirOf(profile, ctx);
  if (!ckDir) return out;               // 名片没说底模在哪 ⇒ 报空清单，一次盘都不读

  if (conv && conv.base_models.length > 0) {
    return declaredBaseModels(profile.id, file, conv.base_models, ckDir, out);
  }

  if (!isDirectory(ckDir)) return out;  // 还没下底模 ⇒ 空清单（界面另有「底模缺」的提示）

  for (const s of slots) {
    const perSlot = path.join(ckDir, s.name);
    if (isDirectory(perSlot)) {
      out[s.name] = listDirEntries(perSlot).map(e => ({ ...e, builtin: true }));
      continue;
    }
    // 没有按位分层 ⇒ 整个底模目录就是这个位的那一个候选，只在单权重位时成立；位不止一个却又没分层，说明名片说的和盘上放置不匹配，宁可报空也不把同一个目录报成两个位的候选。
    if (slots.length === 1) {
      out[s.name] = [statEntry(ckDir, path.basename(ckDir) || profile.id)];
    }
  }
  return out;
}

/** 名片说的底模目录，绝对路径；名片没说就是 null。全平台只有 resolveCheckpointsDir 一个定义处。 */
function ckDirOf(profile, ctx) {
  return resolveCheckpointsDir(
    profile,
    (ctx && ctx.env) || process.env,
    (ctx && ctx.appDir) || APP_DIR,
  ).abs_path;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

/** 每个位都没有候选 ⇒ 这台引擎的底模清单是空的，界面上和「这台引擎没有底模」长一样。 */
function allBucketsEmpty(models) {
  const buckets = Object.values(models);
  return buckets.length > 0 && buckets.every((b) => b.length === 0);
}

/** 所有已装引擎的底模，按引擎分组。形状跟角色资产那侧完全一致：models 是 { 引擎id: { 位名: [候选...] } }，
 *  两边并成一个下拉时不用各写一套拆包代码。
 *  @returns {{ models: object, missing: Array<{engine_id: string, reason: string, message?: string}> }}
 *  missing 说的是「这台引擎的底模清单为什么说不出来」，逐台隔离：一台的 scan.json 写坏
 *  只让它自己说不出，别照常列；错误原文一起带出去，让下拉和音色体检给同一个答复。 */
function baseModelsByEngine(profiles, ctx) {
  const models = {};
  const missing = [];
  for (const p of (profiles || [])) {
    if (!p || !p.id) continue;
    let status;
    let got;
    try {
      // 读约定和列候选用同一个 try：一台坏掉的引擎只让它自己说不出。
      status = readScanStatus(p.id);
      got = baseModelsForEngine(p, ctx, status);
    } catch (err) {
      if (!err || err.code !== 'ENGINE_SCAN_INVALID') throw err;
      missing.push({ engine_id: p.id, reason: 'invalid', message: err.message });
      continue;
    }
    const ckDir = ckDirOf(p, ctx);
    if (status.missing && allBucketsEmpty(got) && ckDir && listDirEntries(ckDir).length > 0) {
      // 底模目录里有文件、候选却一条都报不出来，而 scan.json 又读不出来 ⇒ 缺的就是这份声明。
      // 目录不在或是空的不报：那是「底模还没下」，界面另有提示，此时提 scan.json 反而指错地方。
      missing.push({ engine_id: p.id, reason: status.missing });
    }
    if (Object.keys(got).length) models[p.id] = got;
  }
  return { models, missing };
}

module.exports = {
  baseModelsForEngine,
  baseModelsByEngine,
};
