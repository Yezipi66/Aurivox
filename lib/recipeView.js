'use strict'

// ---------------------------------------------------------------------------
//  配方的 v4 视图 —— 读的时候把老配方看成新形状，**不改磁盘上的任何一个字节**
// ---------------------------------------------------------------------------
//
// 为什么不写迁移脚本：
//
// 仓库里已经有一个 recipeMigration.js，那是 v2→v3 的**路径**迁移 —— 一个
// 相对路径可能有多种解释，所以它必须人工消歧、先备份、可回滚。v3→v4 完全
// 不是那回事：它是纯机械改形，零歧义。给零歧义的改形套上「重写用户磁盘 +
// 备份 + 回滚」这一整套，只是在没有收益的地方引入了丢数据的风险。
//
// 所以这里改成读时视图：
//   - 磁盘上的老配方一个字不动，随时可以退回旧版本
//   - Owner 不需要跑迁移，也不需要先备份 recipes 目录
//   - 新存的配方直接是 v4
//   - 老配方读出来自动是「绑在老路径引擎上的 v4」—— 这本来就是事实，
//     它们全都是 GPT-SoVITS 的配方
//
// ⛔ 本文件不允许出现任何具体引擎的名字。
//
// ⭐⭐⭐ 2026-08-31（刀 A1，Owner 12:22 裁决「直接删」）：
//   这里过去有第二个参数 `legacyEngineId` —— 配方没记引擎时，把它认领给
//   「名片上写 legacy_default 的那台」。**已删。**
//   理由：那是**平台替一条不完整的数据挑了一台引擎**。挑对了没人知道，
//   挑错了症状是「声音不对」而不是任何一句报错。
//   ⇒ 现在没记引擎的配方 `engine_id` 就是空串，由调用方当场拒绝（400），
//     ⛔ 不迁移、⛔ 不标「引擎未知」、⛔ 不替它认领。

const GENERIC_PARAM_KEYS = new Set(['speed', 'seed'])

// v3 那 16 键里，除去通用的两个，其余全是当年那台引擎的私有参数。
// 列在这里不是为了「认识 GPT-SoVITS」，而是为了回答一个纯历史问题：
// 「v3 的 params 里哪些键当年是塞给引擎的」。它们会原样进入
// engine_params[engineId]，一个都不丢。⚠ 配方没记引擎（engineId 为空串）时
// 这一步整段跳过 —— 没有格子可以装，⛔ 不是装进某个兜底的格子。
const V3_ENGINE_PARAM_KEYS = [
  'top_k', 'top_p', 'temperature',
  'text_split_method', 'repetition_penalty', 'sample_steps', 'if_sr',
  'batch_size', 'batch_threshold', 'split_bucket', 'fragment_interval',
  'parallel_infer', 'aux_ref_audio_paths', 'pron_overrides',
]

function isPlainObject (v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 把任意版本的配方读成 v4 形状。纯函数，不碰磁盘。
 *
 * @param {object} recipe          从 recipeStore 读出来的配方
 * @returns {{engine_id, params, engine_params, box, schema_version, raw}}
 *   engine_id     这条配方去哪台引擎。⚠ 配方没记 ⇒ **空串**，
 *                 ⛔ 平台不替它挑一台（刀 A1）
 *   params        通用格子（speed / seed）
 *   engine_params 全部格子，原样
 *   box           engine_params[engine_id]，即这次调用真正要用的那格
 */
function toV4 (recipe) {
  const rec = isPlainObject(recipe) ? recipe : {}
  const version = Number(rec.schema_version) || 1

  // ⭐ 配方没记引擎 ⇒ 空串。这是一个**说得出口的缺失**，⛔ 不是一个待补的默认值。
  //   调用方看到空串就该停下来说「这条配方没说去哪台」，
  //   ⛔ 而不是让平台在这里悄悄填一台上去。
  const engineId = (typeof rec.engine_id === 'string' && rec.engine_id.trim())
    ? rec.engine_id.trim()
    : ''

  const srcParams = isPlainObject(rec.params) ? rec.params : {}

  // 通用格子
  const params = {}
  for (const k of GENERIC_PARAM_KEYS) {
    if (srcParams[k] !== undefined) params[k] = srcParams[k]
  }

  // 引擎格子：先收已经是 v4 的，再把 v3 params 里的私有键补进本引擎那格。
  const engine_params = {}
  if (isPlainObject(rec.engine_params)) {
    for (const [k, v] of Object.entries(rec.engine_params)) {
      if (isPlainObject(v)) engine_params[k] = Object.assign({}, v)
    }
  }

  // recipeStore 在引擎未知时会把未知键收进 "_unassigned" 占位格。这里解析出
  // 真实引擎了，就把它并回去 —— 占位格的存在期只有「存下来到读出来」这一段。
  if (isPlainObject(engine_params._unassigned) && engineId) {
    engine_params[engineId] = Object.assign({}, engine_params._unassigned, engine_params[engineId])
    delete engine_params._unassigned
  }

  if (version < 4 && engineId) {
    const carried = {}
    for (const k of V3_ENGINE_PARAM_KEYS) {
      if (srcParams[k] !== undefined) carried[k] = srcParams[k]
    }
    // 已经在格子里的值优先 —— 显式写的 v4 值不该被 v3 的老值盖掉。
    if (Object.keys(carried).length > 0) {
      engine_params[engineId] = Object.assign(carried, engine_params[engineId])
    }
  }

  return {
    schema_version: version,
    engine_id: engineId,
    params,
    engine_params,
    box: engine_params[engineId] || {},
    raw: rec,
  }
}

/**
 * 调用层要的「一包参数」：通用格子 + 本引擎格子合成一张平表。
 *
 * 这一步是**给老合成路径用的**：它今天按 GPT-SoVITS 的形状读 recipe.params.*，
 * 合成平表之后那些读法一个字都不用改。⛔ 平台在这里仍然不看键名 ——
 * 只是把两格倒进同一个碗，倒的过程不认识任何一个键。
 */
function flatParams (v4) {
  return Object.assign({}, v4.box, v4.params)
}

module.exports = { toV4, flatParams, GENERIC_PARAM_KEYS, V3_ENGINE_PARAM_KEYS }
