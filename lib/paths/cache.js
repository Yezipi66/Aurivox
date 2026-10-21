// lib/paths/cache.js
// 缓存路径：cache/ 下的可再生产物
const path = require('path');
const { APP_DIR, envDir } = require('./system');

const CACHE_DIR = envDir('CACHE_DIR', path.join(APP_DIR, 'cache'));

const CACHE = {
  numba: path.join(CACHE_DIR, 'numba'),
  hf: path.join(CACHE_DIR, 'hf'),
  modelscope: path.join(CACHE_DIR, 'modelscope'),
  torch: path.join(CACHE_DIR, 'torch'),
  dict: path.join(CACHE_DIR, 'dict'),
  segments: path.join(CACHE_DIR, 'segments'),
};

module.exports = { CACHE_DIR, CACHE };
