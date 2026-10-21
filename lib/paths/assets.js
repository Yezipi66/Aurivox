// lib/paths/assets.js
// 资产与暂存相关路径
const path = require('path');
const { APP_DIR, readConfig, envDir } = require('./system');

// 资产根解析优先级：环境变量 ASSETS_ROOT > app-config.json(assetsRoot) > <项目>/assets
const _cfg = readConfig();
let ASSETS_ROOT_SOURCE = 'default';
let ASSETS_ROOT;
if (process.env.ASSETS_ROOT) {
  ASSETS_ROOT = path.resolve(process.env.ASSETS_ROOT);
  ASSETS_ROOT_SOURCE = 'env';
} else if (_cfg.assetsRoot) {
  ASSETS_ROOT = path.resolve(_cfg.assetsRoot);
  ASSETS_ROOT_SOURCE = 'config';
} else {
  ASSETS_ROOT = path.join(APP_DIR, 'assets');
  ASSETS_ROOT_SOURCE = 'default';
}

// 暂存根：始终与 ASSETS_ROOT 同盘（放其同级 .staging/），保证 rename 原子、无 EXDEV
const STAGING_ROOT = path.join(ASSETS_ROOT, '..', '.staging');

// 资产内部的子目录名
const CUSTOM_REFS_DIRNAME = 'custom_refs';

module.exports = {
  ASSETS_ROOT, ASSETS_ROOT_SOURCE, STAGING_ROOT, CUSTOM_REFS_DIRNAME,
};
