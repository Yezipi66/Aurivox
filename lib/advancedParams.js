'use strict';

// advanced_params.json 是界面状态的记忆，不是默认值表。默认值的唯一产地是引擎名片。
// load = { ...名片默认值, ...盘上文件 }：盘上赢，用户拧过的值该盖住名片默认值。
// save = { ...本次提交, updated_at }：替换而不是合并，否则盘上会长出名片默认值的全量副本。
// 本文件不认识任何引擎名或参数名，只搬运键值对。

/** 造存取器。engineDefaults 必须是函数（运行时事实）；launchDefaults 是启动期设置，目前无人读。 */
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

  // engineId 为空 = 「这次没人说是哪台」：底座里不留任何引擎默认值，也不回落到某一台。
  function defaults(engineId) {
    return { ...engineDefaults(engineId), ...launchDefaults };
  }

  function load(engineId) {
    const base = defaults(engineId);
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

  // 替换，不是合并：合并会把名片默认值拓印到盘上。
  function save(params) {
    const merged = { ...(params || {}), updated_at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
  }

  return { defaults, load, save };
}

module.exports = { createAdvancedParamsStore };
