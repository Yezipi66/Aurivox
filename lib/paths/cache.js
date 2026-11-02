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
  uv: path.join(CACHE_DIR, 'uv'),
};

// uv 的包缓存放项目里，不放用户目录：uv 默认写 %LOCALAPPDATA%\uv\cache，
// 那是当前登录用户才能看到的地方，装在同一台机器上的另一个项目看不见它，
// 搬走项目目录也不会跟着走。放在 cache/ 下则跟项目同盘，uv 能用硬链接
// 把文件链进各个虚拟环境，省掉每台引擎一份完整拷贝。
//
// root 传项目根：向导按它自己操作的项目根定位缓存，其余场合用平台根。
// 环境变量覆盖：部署到别处时可用 CACHE_DIR 改缓存根、UV_CACHE_DIR 单独指定。
function uvCacheDirFor (root) {
  const base = envDir('CACHE_DIR', path.join(root || APP_DIR, 'cache'));
  return envDir('UV_CACHE_DIR', path.join(base, 'uv'));
}

const UV_CACHE_DIR = uvCacheDirFor(APP_DIR);

module.exports = { CACHE_DIR, CACHE, UV_CACHE_DIR, uvCacheDirFor };
