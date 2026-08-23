'use strict';

// ============================================================
//  advanced_params.json —— 「界面上次拧到哪」的记忆
// ============================================================
//
// ⭐⭐ 这个文件的语义只有一句话：
//        **它是界面状态的记忆，不是默认值表。**
//     默认值的唯一产地是引擎名片（契约 C11：参数表只有一份）。
//
// 这句话是 2026-08-23 重新划的界。在那之前它同时扮演两个角色，症状如下：
//
//   ① 写 18 读 7。GenerateTab 每次成功合成回存 18 个键，而全前端读得回来的
//      只有 7 个（temperature / top_k / top_p / repetition_penalty /
//      text_split_method / speed_factor / seed —— GenerateTab 挂载时那一段和
//      ReferenceCompareTab 建行时用的正是同一组）。另外 11 个只写不读。
//
//   ② 存一次，就把名片默认值全量拓印到盘上。原来的 save 是
//        { ...load(), ...params }，而 load() 是 { ...名片默认值, ...盘上文件 }。
//      两者叠起来 ⇒ 盘上文件会长出**当时**的全部名片默认值，而下次 load 时
//      盘上那份又赢过名片。于是它变成一张会自我固化的陈年快照。
//
//      实测真机盘上文件盖掉了 6 个名片默认值：
//        batch_size  名片 4  → 盘上 1           ← C11 刚裁定的 4 在真机上等于没生效
//        top_k       名片 15 → 盘上 20
//        temperature 名片 1  → 盘上 0.8
//        seed        名片 -1 → 盘上 2769901998  ← 一次性随机种子被冻成永久默认值
//        version     v2Pro   → v2              ← 启动期设置被合成参数文件盖掉
//        is_half     true    → false
//      其中 batch_size / version / is_half 用户**从没在界面上碰过**，纯粹是那条
//      merge 自己拓印上去的。这就是 C11 说的副本，只不过副本落在盘上而非代码里。
//
// 现在的规矩：
//   load  = { ...名片默认值, ...盘上文件 }   ← 不变，用户拧过的就该赢
//   save  = { ...本次提交, updated_at }      ← **替换**，不再合并
//   ⇒ 盘上只可能有用户在界面上真的拧过的键，其余一律退回名片。
//
// ⭐ 为什么 save 不带一张「允许持久化的键名清单」：那又是一份写死的参数表，
//    正是 C11 禁止的东西。改成替换就一个键名都不必点 —— 存什么由**界面上真的
//    有哪些格子**决定，而界面本身正在改成按名片 param_schema 渲染。
//
// ⚠ 因此 save 要求调用方提交**完整的界面状态**，不是增量补丁。
// ⭐ 自愈：第一次保存后，盘上那些只写不读的陈年键会被这次替换清掉。
//
// ⛔ 本文件内不许出现任何引擎名或参数名（契约 C11）。
//    它只搬运键值对，从不认识其中任何一个键。

/**
 * 造一个 advanced_params 存取器。
 *
 * 之所以做成工厂而不是直接导出函数：server.js 一被 require 就 listen，
 * 进不了测试进程 —— 这几个函数留在 server.js 里就永远测不到。事实上
 * 改成替换语义时全量 661 条测试**一条没红**，正是因为没人守着它。
 *
 * @param {object}   deps
 * @param {string}   deps.file            盘上文件路径（来自 lib/paths.js）
 * @param {function} deps.engineDefaults  () => 名片默认值对象。⭐ 必须是函数：
 *                                        装了哪些引擎、环境变量拧到几，都是
 *                                        **运行时事实**；存成常量就等于在进程
 *                                        启动那一瞬间又拍了一张快照。
 * @param {object}  [deps.launchDefaults] 启动期设置（改了要重启引擎进程）。
 *                                        ⚠ 挂账：2026-08-23 查实这几个键**零
 *                                        消费者** —— 只被这里生产、由 GET 吐出，
 *                                        没有任何代码读。留着是现状不是设计。
 * @param {object}  [deps.fs]             注入用
 * @param {object}  [deps.logger]         注入用
 */
function createAdvancedParamsStore({
  file,
  engineDefaults,
  launchDefaults = {},
  fs = require('fs'),
  logger = console,
}) {
  if (!file) throw new Error('createAdvancedParamsStore requires a file path');
  if (typeof engineDefaults !== 'function') {
    throw new Error('createAdvancedParamsStore requires engineDefaults to be a function');
  }

  function defaults() {
    return { ...engineDefaults(), ...launchDefaults };
  }

  function load() {
    const base = defaults();
    try {
      if (!fs.existsSync(file)) return base;
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // 盘上的赢：用户在界面上拧过的值，理应盖住名片默认值。
      return { ...base, ...data };
    } catch (e) {
      logger.error('[ADVANCED_PARAMS] Failed to read:', e.message);
      return base;
    }
  }

  // ⭐⭐ 替换，不是合并。理由见本文件顶部第 ② 条。
  function save(params) {
    const merged = { ...(params || {}), updated_at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  return { defaults, load, save };
}

module.exports = { createAdvancedParamsStore };
