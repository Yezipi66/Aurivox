const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..');

// 资产根：可通过环境变量 ASSETS_ROOT 覆盖（绝对路径）。默认 <项目>/assets
const ASSETS_ROOT = process.env.ASSETS_ROOT
  ? path.resolve(process.env.ASSETS_ROOT)
  : path.join(APP_DIR, 'assets');

// 暂存根：始终与 ASSETS_ROOT 同盘（放其同级 .staging/），保证 rename 原子、无 EXDEV
const STAGING_ROOT = path.join(ASSETS_ROOT, '..', '.staging');

fs.mkdirSync(ASSETS_ROOT, { recursive: true });
fs.mkdirSync(STAGING_ROOT, { recursive: true });

module.exports = { APP_DIR, ASSETS_ROOT, STAGING_ROOT };
