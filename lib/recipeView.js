'use strict'

// 配方的 v4 视图：读的时候把旧版本配方看成 v4 形状，不改磁盘上的任何一个字节。
// 配方没记引擎时 engine_id 是空串，由调用方当场拒绝：平台替一条不完整的数据挑一台引擎，
// 挑错了症状是「声音不对」而不是任何一句报错。
// 本文件不出现具体引擎名：配方只存引擎 id。

const GENERIC_PARAM_KEYS = new Set(['speed', 'seed'])

// v3 配方里属于引擎格子的键。存量配方已经写死了这些键名，删一个就会漏搬用户已存的值；
// 它们原样进入 engine_params[engineId] 那格，一个都不丢。
// 配方没记引擎时这一整段跳过：没有格子可以装，不是装进某个兜底的格子。
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
 * @returns {{engine_id, params, engine_params, box, schema_version, raw}}
 * engine_id 这条配方去哪台引擎；params 是通用格子（speed / seed）；engine_params 是全部格子；
 * box 是 engine_params[engine_id]，即这次调用真正要用的那格。
 */
function toV4 (recipe) {
 const rec = isPlainObject(recipe) ? recipe : {}
 const version = Number(rec.schema_version) || 1

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

  // 引擎未知时被收进 _unassigned 的键，解析出真实引擎后并回本引擎那格，占位格随即删除。
  if (isPlainObject(engine_params._unassigned) && engineId) {
 engine_params[engineId] = Object.assign({}, engine_params._unassigned, engine_params[engineId])
 delete engine_params._unassigned
 }

 if (version < 4 && engineId) {
 const carried = {}
 for (const k of V3_ENGINE_PARAM_KEYS) {
 if (srcParams[k] !== undefined) carried[k] = srcParams[k]
 }
 // 已经在格子里的值优先：显式写的 v4 值不该被 v3 那一份盖掉。
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
 * 通用格子 + 本引擎格子合成一张平表，供按 recipe.params.* 读参数的调用方使用。
 * 合成过程不认识任何一个键名，也不做键名翻译。
 */
function flatParams (v4) {
 return Object.assign({}, v4.box, v4.params)
}

module.exports = { toV4, flatParams, GENERIC_PARAM_KEYS, V3_ENGINE_PARAM_KEYS }
