'use strict'
// 复核 Manifest 参数该归「常用」还是「进阶」档：只做名字与相位的启发式判断，不改参数本身，
// 也不替接入者决定。写了的档位不动，留空的按规则落进进阶档（安全默认）。
//
// 启发词表收的是「一般由平台/引擎自己处理」的开关：随机性、性能开关、分段与长度控制。
// 只放作用词，不放具体参数名（某台引擎的参数全名放进来等于把词汇固化进平台）。

const ADVANCED_HINTS = Object.freeze([
  'verbose', 'debug', 'log', 'log_level', 'quiet', 'trace',
  'seed', 'random', 'use_random', 'temperature_sched',
  'use_fp16', 'use_cuda', 'cuda_kernel', 'deepspeed', 'accel',
  'torch_compile', 'batch', 'num_workers', 'n_jobs',
  'max_text', 'token_limit', 'chunk', 'segment',
  'use_emo_text', 'emo_text', 'emo_vector',
])

/**
 * 复核一条草稿的档位。
 * @returns {{tier: string, source: string, why: string}}
 */
function reviewTier (entry) {
  const name = String((entry && entry.name) || '').toLowerCase()

  if (entry && entry.phase === 'load') {
    return {
      tier: 'advanced',
      source: '先验',
      why: 'phase=load 是装引擎时定一次的开关，日常调用不该露出来。',
    }
  }

  const hit = ADVANCED_HINTS.find((h) => name === h || name.includes(h))
  if (hit) {
    return {
      tier: 'advanced',
      source: '名字启发',
      why: `名字含「${hit}」，那通常是调试/性能/随机性开关，对普通用户属于进阶档。`,
    }
  }

  return {
    tier: null,
    source: '不定',
    why: '名字看不出常用度。留空 ⇒ 平台按规则落进进阶档（安全的默认）；' +
      '若它确实是常用项，请显式写 "tier": "common"。',
  }
}

/**
 * 复核整份草稿。
 * @returns {{parameters: Array, reviewed: number, blank: number}}
 */
function reviewTiers (parameters) {
  let reviewed = 0
  let blank = 0
  for (const entry of parameters || []) {
    if (!entry || typeof entry !== 'object') continue
    const r = reviewTier(entry)
    if (entry.tier === undefined || entry.tier === null) {
      entry.tier = r.tier === null ? undefined : r.tier
      entry._tier_review = {
        source: r.source,
        why: r.why,
        decided: r.tier !== null,
      }
      if (r.tier !== null) reviewed += 1
      else blank += 1
    }
  }
  return { parameters, reviewed, blank }
}

module.exports = { reviewTier, reviewTiers, ADVANCED_HINTS }
