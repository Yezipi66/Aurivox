'use strict'

// 引擎子进程的环境。两条拉起路径共用这一份：
//   lib/engines/spawnEngine.js      平台常驻地起一台引擎
//   tools/engine-wizard/core/hostRunner.js  第 5 步临时起一台宿主做试运行
// 两处各写一遍的话，向导里验不过而平台跑得起来（或者反过来），
// 而差别只在环境变量上，排查时看不出是哪一处漏了。

const fs = require('node:fs')

const P = require('../paths')

// 继承来的这几个必须删掉：不删，继承值会盖掉这里指定的位置。
const INHERITED_CACHE_KEYS = ['MODELSCOPE_CACHE', 'HF_HOME', 'HUGGINGFACE_HUB_CACHE', 'TORCH_HOME']

/**
 * 构造给引擎子进程的环境。
 *
 * 运行期缓存按引擎隔离（`engines/<id>/.cache/`），不共用全局目录：
 *   共用时同一个公共模型只存一份，省磁盘；代价是落在平台视野之外、与别的引擎
 *   互相污染、删一台引擎也带不走它。引擎自己拉的权重本来就该跟着引擎走，
 *   落点可预测，第 3 步和第 5 步才说得清「它在哪」。
 *   id 缺失时退回全局目录（`models/engine-pulled/`），只给不知道是哪台的调用方。
 *
 * ffmpeg 不在这里加：它由 host.py 自己摆（见 `lib/engines/host.py` 的
 *   `_activate_runtime_env`）。那样手工拉起宿主时也一致，不必依赖调用方。
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.base] 继承的 env，默认 process.env
 * @param {string} [opts.id] 引擎 id：缓存落到它的目录下
 * @returns {NodeJS.ProcessEnv}
 */
function engineChildEnv (opts = {}) {
  const env = Object.assign({}, opts.base || process.env)

  // broker 自己跑在别的 venv 里，继承后引擎 import 到的不是引擎 venv 里的包，
  //   症状是「加载失败」而环境本身没问题。
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  delete env.VIRTUAL_ENV

  for (const k of INHERITED_CACHE_KEYS) delete env[k]
  const pulled = P.engineCacheDirs(opts.id)
  env.MODELSCOPE_CACHE = pulled.modelscope
  env.HF_HOME = pulled.huggingface
  env.TORCH_HOME = pulled.torch
  for (const dir of Object.values(pulled)) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch (_) { /* 建不了就让引擎自己报错 */ }
  }

  return env
}

module.exports = { engineChildEnv, INHERITED_CACHE_KEYS }