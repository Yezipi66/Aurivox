'use strict';

// 「上一次成功调用时填的值」只有一份，就是那次生成落盘时写下的 meta.recipe（判据见 issue #26 §14）。
// 本文件不另存一份参数值：再存一份就有两套真相，它们早晚不一致。它只负责把最近那一次成功的
// recipe 从输出目录里捞出来。
//
// 只在请求里出现「留空的格子」时才捞：正常请求一个文件都不多读。捞法是「新→旧取前若干条」，
// 生成目录名是 ISO 时间戳打头（lib/genUtils.js 的 newGenId），所以目录名字典序就是时间序。

const LOOKBACK = 40;

// 只有界面上的调用才有「上一次」可言：生成页与对比页（Flow 走的是生成页那一条，source 也是 generate）。
// 机器入口（/v1、Broker）落在 source=broker 里，不参选（判据 8）。
const UI_SOURCES = ['generate', 'comparerefs'];

/**
 * 读这台引擎最近一次成功生成的配方。
 * @returns {object|null} 找不到（这台引擎没装过、目录被清了、那一次的 status 不是 ok）就返回 null，交回「不做任何补全」那一条。
 */
function readLastSuccessRecipe({ engineId, outputRoots, fs, path, lookback = LOOKBACK }) {
  if (!engineId || !outputRoots) return null;
  const found = [];
  for (const root of Object.values(outputRoots)) {
    let names;
    try { names = fs.readdirSync(root); } catch (_) { continue; }
    for (const name of names) found.push({ id: name, dir: path.join(root, name) });
  }
  found.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  for (const item of found.slice(0, lookback)) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(item.dir, 'meta.json'), 'utf-8'));
    } catch (_) { continue; }
    if (!meta || meta.status !== 'ok') continue;
    if (meta.engine_id !== engineId) continue;
    if (!UI_SOURCES.includes(meta.source)) continue;
    if (!meta.recipe || typeof meta.recipe !== 'object') continue;
    return meta.recipe;
  }
  return null;
}

module.exports = { readLastSuccessRecipe, LOOKBACK };
