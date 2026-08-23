'use strict'

// ---------------------------------------------------------------------------
//  Engine profile — 把「名片上写的」翻成「合成路径能用的」
// ---------------------------------------------------------------------------
// 契约 v2 第 1 步。在这个文件出现之前，六件事写死在 lib/ 里，全都按
// GPT-SoVITS 的样子写死：
//
//   连哪台        lib/gsv/client.js:10   "http://127.0.0.1:9880"
//   等多久        lib/gsv/client.js      300000（三处重复）
//   切多长        synthesisService.js    30 / 60
//   参考音频多长  synthesisService.js    3–10 秒
//   要不要换权重  无条件调 switchModels
//   采样率        22050（生成段间静音用）
//
// 从这里开始，它们的唯一来源是 engines/<id>/manifest.json。lib/ 下不再有
// 任何一个具体引擎的默认值 —— 这就是「加引擎不改代码」的字面意思。
//
// ⚠ 本文件里**不允许出现任何具体引擎的名字**（和 registry.js 同一条纪律，
//   profile.node.test.js 里有一条守卫盯着）。一旦为了图快写 if (id==='xxx')，
//   那台引擎的特殊性就永久留在了平台层，下一个人只会照抄。

const { requireEngine } = require('./registry')

function profileError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// 缺字段就报错，不回落 —— Owner 2026-08-23 拍板选 A。
//
// 理由不是洁癖：回落到默认值意味着「名片写错了」和「名片写对了」表现完全
// 一样，作者不会发现，直到有一天连到了别人的引擎上。报错是这里唯一能给出
// 「你少写了哪一行」这个信息的时刻，错过了就再也没有了。
function required(manifest, keyPath, value, hint) {
  if (value === undefined || value === null || value === '') {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的名片缺少 ${keyPath} —— ${hint}。` +
      `请在 ${manifest.dir}/manifest.json 里补上这一行；` +
      '平台不为它准备默认值（默认值会让「写错」和「没写」表现一致）。',
      { id: manifest.id, missing: keyPath })
  }
  return value
}

function positiveInt(manifest, keyPath, value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的名片里 ${keyPath} 必须是正整数，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return n
}

// 布尔位必须显式写 true/false。缺了要报错，所以不能用 `|| false` 兜。
function requiredBool(manifest, keyPath, value, hint) {
  if (typeof value !== 'boolean') {
    throw profileError(
      value === undefined ? 'ENGINE_MANIFEST_INCOMPLETE' : 'ENGINE_MANIFEST_INVALID_VALUE',
      value === undefined
        ? `引擎 ${manifest.id} 的名片缺少 ${keyPath} —— ${hint}。请写明 true 或 false。`
        : `引擎 ${manifest.id} 的名片里 ${keyPath} 必须是 true 或 false，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: keyPath, value })
  }
  return value
}

// 参考音频时长约束。三种写法含义不同，不能混为一谈：
//   null        —— 明确声明「不限制」
//   [min, max]  —— 闭区间，秒
//   缺这个键    —— 报错。「忘了写」和「不限制」必须能区分开，否则一个漏写
//                 会静默变成「什么音频都收」，等到合成失败才发现。
function parseClipSeconds(manifest, value) {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== 2) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 capabilities.reference_clip_seconds 要么写 null（不限制），` +
      `要么写 [最短秒, 最长秒]，现在写的是 ${JSON.stringify(value)}`,
      { id: manifest.id, key: 'capabilities.reference_clip_seconds', value })
  }
  const min = Number(value[0])
  const max = Number(value[1])
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= min) {
    throw profileError('ENGINE_MANIFEST_INVALID_VALUE',
      `引擎 ${manifest.id} 的 reference_clip_seconds 区间不成立：${JSON.stringify(value)}（要求 0 ≤ 最短 < 最长）`,
      { id: manifest.id, key: 'capabilities.reference_clip_seconds', value })
  }
  return { min, max }
}

// 环境变量覆盖：**由名片自己指定变量名**，平台不认识任何具体的变量名。
//
// 这是为了让 GPT_SOVITS_BASE_URL 这种历史环境变量继续工作，同时不把
// 「GPT_SOVITS」这几个字写进 lib/。名片说「我听 XXX 这个变量」，平台才去读。
// 下游引擎想要同样的能力，写一行 base_url_env 就有，不用求我们改代码。
function resolveBaseUrl(manifest, env) {
  const envKey = manifest.base_url_env
  if (envKey && env[envKey]) {
    return { base_url: String(env[envKey]).replace(/\/+$/, ''), source: `env:${envKey}` }
  }
  const declared = required(manifest, 'default_base_url', manifest.default_base_url,
    '平台不知道该把合成请求发到哪个地址')
  return { base_url: String(declared).replace(/\/+$/, ''), source: 'manifest' }
}

/**
 * 读一张名片，产出合成路径要用的东西。缺一项就抛，不猜。
 *
 * @param {string} id     引擎目录名 = 引擎 id
 * @param {object} [env]  环境变量表（测试用），默认 process.env
 * @throws FG_ENGINE_UNSUPPORTED / ENGINE_MANIFEST_INCOMPLETE / ENGINE_MANIFEST_INVALID_VALUE
 */
function resolveEngineProfile(id, env = process.env) {
  const manifest = requireEngine(id)          // 没装这个引擎 ⇒ FG_ENGINE_UNSUPPORTED
  const caps = manifest.capabilities || {}

  const { base_url, source } = resolveBaseUrl(manifest, env)

  const timeout_ms = positiveInt(manifest, 'timeout_ms',
    required(manifest, 'timeout_ms', manifest.timeout_ms,
      '平台不知道一段合成等多久算超时（这个值按「每一段」计，不是整篇）'))

  const max_chars = positiveInt(manifest, 'max_chars',
    required(manifest, 'max_chars', manifest.max_chars,
      '平台不知道该把长文本切成多长一段（慢引擎必须调小，否则单段就撑爆超时）'))

  if (!('reference_clip_seconds' in caps)) {
    throw profileError('ENGINE_MANIFEST_INCOMPLETE',
      `引擎 ${manifest.id} 的名片缺少 capabilities.reference_clip_seconds —— ` +
      '不限制请显式写 null。「忘了写」和「不限制」必须能区分开，' +
      '否则一个漏写会静默变成「什么参考音频都收」，等到合成失败才发现。',
      { id: manifest.id, missing: 'capabilities.reference_clip_seconds' })
  }

  return {
    id: manifest.id,
    label: manifest.label || manifest.id,
    dir: manifest.dir,
    base_url,
    base_url_source: source,
    timeout_ms,
    max_chars,
    // 硬上限 = 软上限 ×2，与 synthesisService 今天的算法一致，不是新规则。
    hard_max_chars: max_chars * 2,
    requires_reference_audio: requiredBool(manifest,
      'capabilities.requires_reference_audio', caps.requires_reference_audio,
      '平台不知道没有参考音频时该不该拦下来'),
    reference_clip_seconds: parseClipSeconds(manifest, caps.reference_clip_seconds),
    hot_swap_models: requiredBool(manifest,
      'capabilities.hot_swap_models', caps.hot_swap_models,
      '平台不知道每次合成前该不该去换权重（不支持热切的引擎，换权重只能重启进程）'),
    output_sample_rate: positiveInt(manifest, 'capabilities.output_sample_rate',
      required(manifest, 'capabilities.output_sample_rate', caps.output_sample_rate,
        '平台生成段间静音和做拼接时要用它；猜错了会得到变调或对不上的静音')),
    // 契约 v2 只管推理：这个键唯一的用途是决定训练页显不显示。
    // 没写 = false，这是契约明文规定的默认，不算「猜」。
    supports_finetune: caps.supports_finetune === true,
    streaming: caps.streaming === true,
    param_keys: manifest.param_keys || [],
  }
}

module.exports = { resolveEngineProfile }
