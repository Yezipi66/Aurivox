'use strict';

// 「先查缓存，没有才推理」的那几行策略。算错了不会报错，只会让用户听到上一次的音频，
// 所以策略要可测：留在这里，接线留在 server.js。out 写上 { key, cached }。
const SWEEP_EVERY_MISSES = 64;
const _counters = { hits: 0, misses: 0 };

async function inferWithCache (cache, { profile, payload, cfg = {} }, infer, out = {}, deps = {}) {
  const logger = deps.logger || console;
  const counters = deps.counters || _counters;

  const key = cache.fingerprint({ profile, payload, cfg });
  out.key = key;
  out.cached = false;

  // force_resynth 只跳过读不跳过写：跳过写的话「强制重推一次」就变成「从此永不命中」。
  if (!cfg.force_resynth) {
    const hit = cache.get(key);
    if (hit) {
      // 缓存文件从不被任何 meta.json 指着，用户删 outputs/ 也不会让历史烂掉。
      logger.log(`[CACHE] 命中，跳过推理: ${key.slice(0, 12)} (${hit.length} bytes)`);
      out.cached = true;
      counters.hits++;
      return hit;
    }
  }

  const bytes = await infer();
  // 推理失败时 infer() 抛错，下面这些行到不了：绝不能把失败的结果或不完整的字节存成
  // 缓存条目，那会一直命中下去。
  cache.put(key, bytes);
  counters.misses++;
  if (counters.misses % SWEEP_EVERY_MISSES === 0) cache.sweep();
  return bytes;
}

module.exports = { inferWithCache, SWEEP_EVERY_MISSES, _counters };
