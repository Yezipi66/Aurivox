'use strict'
// ============================================================================
//  TIER REVIEW —— 参数档位复核
//
//  ⭐ 为什么这一层存在（实测发现的真冲突，不是我想出来的）
//
//  tools/scaffold-params.cjs:264 现在这么写：
//      tier: phase === 'load' ? 'advanced' : 'common'
//  即「load → 进阶、call → 常用」。
//
//  但拿真引擎一比就不对（2026-10-04 在一张 14 参数的真名片上数过）：
//      phase=call 里 tier=common 3 个 · tier=advanced 6 个
//      common    : emo_alpha / interval_silence / emo_audio_prompt
//      advanced  : verbose / max_text_tokens_per_segment / emo_vector
//                  use_emo_text / emo_text / use_random
//
//  ⇒「call 就是常用」会把 9 个全塞进常用档，而真正该进常用的只有 3 个。
//    verbose（打印日志）、use_random（随机种子）这种调试开关进常用档，
//    **恰好制造我们想消除的那种心智负担** —— 用户看到一片格子不知道哪些要紧。
//
//  ⚠ 而 phase=load → advanced 这一半是**对的**，有强先验：
//    装机器时定一次的开关，日常不碰。三台真引擎全部如此。
//
//  ⇒ 这一层做三件事：
//    1. 承认 load → advanced（照搬，先验可靠）
//    2. call → common 只给**一个名字启发**的建议，其余留空让人定
//    3. 每条建议都标「这是建议不是事实」，且能被一键忽略
//
//  ⛔⛔ 纪律：这里不许出现任何具体引擎名。
//  参照实例在 instances.cjs 里以**数据**形式给，不写在算法里。
// ============================================================================

/**
 * 常见度启发 —— 名字形态 → 大概率是「进阶参数」。
 *
 * ⭐ 这些词是**界面词汇**，不是某台引擎的词汇：
 *   一个装在界面上的开关，如果它的作用是「调试」「日志」「随机性」，
 *   那么对**任何**引擎的用户，它都属于进阶档。
 *   判据：装一台谁都没见过的引擎，这一层一个字都不用改。
 */
const ADVANCED_HINTS = Object.freeze([
  // 调试与诊断
  'verbose', 'debug', 'log', 'log_level', 'quiet', 'trace',
  // 随机性 —— 影响可复现，普通用户不碰
  'seed', 'random', 'use_random', 'temperature_sched',
  // 性能开关（装机器时考虑，不是每次调用）
  'use_fp16', 'use_cuda', 'cuda_kernel', 'deepspeed', 'accel',
  'torch_compile', 'batch', 'num_workers', 'n_jobs',
  // 分段与长度控制（一般由平台/引擎自己处理）
  // ⚠ 只放**作用词**，不放具体参数名。`max_text_tokens_per_segment` 是某台
  //   引擎的参数全名，放进来就等于把它的词汇固化进平台 —— 测试会抓这一条。
  'max_text', 'token_limit', 'chunk', 'segment',
  // 内部结构的开关（用户一般不需要知道上游怎么分块）
  'use_emo_text', 'emo_text', 'emo_vector',
])

/**
 * 复核一条草稿的档位。
 * @param {object} entry  parameters[] 的一���
 * @returns {{tier: string, source: string, why: string}}
 */
function reviewTier (entry) {
  const name = String((entry && entry.name) || '').toLowerCase()

  // load：强先验，直接给 advanced
  if (entry && entry.phase === 'load') {
    return {
      tier: 'advanced',
      source: '先验',
      why: 'phase=load 是「装引擎时定一次」的开关，日常调用不该露出来（三台真引擎全部如此）。',
    }
  }

  // 名字命中进阶启发词
  const hit = ADVANCED_HINTS.find((h) => name === h || name.includes(h))
  if (hit) {
    return {
      tier: 'advanced',
      source: '名字启发',
      why: `名字含「${hit}」，那通常是调试/性能/随机性开关，对普通用户属于进阶档。`,
    }
  }

  // 命中不了 ⇒ **不给建议**
  // ⛔ 这是本层最重要的一条：宁可留空让人定，也不要瞎填。
  //   平台那条规则是「没写 tier ⇒ 落进 advanced」（web/src/lib/engines.js:164），
  //   ⇒ 留空 = 沉到进阶档，是**安全的默认**；瞎填 common 才是危险的。
  return {
    tier: null,
    source: '不定',
    why: '名字看不出常用度。留空 ⇒ 平台按规则落进进阶档（安全的默认）；' +
      '若它确实是常用项，请显式写 "tier": "common"。',
  }
}

/**
 * 复核整份草稿。
 * @param {Array} parameters  parameters[] 草稿（就地修改，返回同一份）
 * @returns {{parameters: Array, reviewed: number, blank: number}}
 */
function reviewTiers (parameters) {
  let reviewed = 0
  let blank = 0
  for (const entry of parameters || []) {
    if (!entry || typeof entry !== 'object') continue
    const r = reviewTier(entry)
    // ⛔ 只在「原来没写」时才填 —— 人已经填过的不覆盖
    if (entry.tier === undefined || entry.tier === null) {
      entry.tier = r.tier === null ? undefined : r.tier
      entry._tier_review = {
        source: r.source,
        why: r.why,
        // 没建议就是「留空」，这是合法结果，不是失败
        decided: r.tier !== null,
      }
      if (r.tier !== null) reviewed += 1
      else blank += 1
    }
  }
  return { parameters, reviewed, blank }
}

module.exports = { reviewTier, reviewTiers, ADVANCED_HINTS }