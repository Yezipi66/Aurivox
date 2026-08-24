'use strict';

// ===========================================================================
//  「先查缓存，没有才推理」的那几行策略
// ===========================================================================
//
// 存放位置是刻意的。这几行是全仓**出错代价最高**的代码之一：算错了不会报错，
// 只会让用户听到上一次的音频。而它天然的位置（server.js 的 generateOneSegment，
// 因为只有那里握着拼好的 payload）恰恰是全仓唯一进不了测试进程的文件
// —— server.js 一被 require 就 app.listen。
//
// 所以把**策略**留在这里（可被测试直接调用），把**接线**留在 server.js
// （只剩一次函数调用，配弱文本守卫 + 突变验证盯着）。

// 攒够一批未命中再扫盘淘汰，不是每段都扫（sweep 要 readdir + 逐个 stat）。
const SWEEP_EVERY_MISSES = 64;

const _counters = { hits: 0, misses: 0 };

/**
 * @param {object}   cache          createSegmentCache 的产物
 * @param {object}   a.profile      引擎名片
 * @param {object}   a.payload      ⭐ 真正要发给引擎的那个对象
 * @param {object}   a.cfg          平台配置（读 gpt_model/sovits_model/force_resynth）
 * @param {function} infer          () => Promise<Buffer>，真正去推理
 * @param {object}  [out]           出参：写上 { key, cached }
 * @param {object}  [deps]          { logger, counters } 便于测试观察
 * @returns {Promise<Buffer>} 音频字节
 */
async function inferWithCache (cache, { profile, payload, cfg = {} }, infer, out = {}, deps = {}) {
  const logger = deps.logger || console;
  const counters = deps.counters || _counters;

  const key = cache.fingerprint({ profile, payload, cfg });
  out.key = key;
  out.cached = false;

  // ⭐ force_resynth 只跳过**读**，不跳过写。
  //   跳过写的话，「强制重推一次」就会变成「从此永不命中」—— 用户勾它是为了
  //   拿一版新的，不是为了永久关掉缓存。而且这个开关是持久化的（产品定位是
  //   恢复用户上次的设置），所以它可能长期勾着；那时仍然写入，是为了用户
  //   取消勾选的那一刻立刻就有得可用。
  if (!cfg.force_resynth) {
    const hit = cache.get(key);
    if (hit) {
      // 把字节交出去就完了 —— 调用方照常写进它自己的产物目录（Owner 定的
      // 「复制不引用」）。缓存文件从不被任何 meta.json 指着，所以用户随时
      // 删 outputs/ 都不会让历史记录烂掉，也就不需要任何删除联动。
      logger.log(`[CACHE] 命中，跳过推理: ${key.slice(0, 12)} (${hit.length} bytes)`);
      out.cached = true;
      counters.hits++;
      return hit;
    }
  }

  const bytes = await infer();
  // ⛔ 推理失败时 infer() 抛错，下面这些行到不了 —— 正是想要的：绝不能把
  //   失败的结果、半截字节或空响应存成缓存条目，那会一直命中下去。
  cache.put(key, bytes);
  counters.misses++;
  if (counters.misses % SWEEP_EVERY_MISSES === 0) cache.sweep();
  return bytes;
}

module.exports = { inferWithCache, SWEEP_EVERY_MISSES, _counters };
