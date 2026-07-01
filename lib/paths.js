const path = require('path');
const fs = require('fs');

const APP_DIR = path.resolve(__dirname, '..');

// 本地配置文件（不依赖 dotenv）：持久化用户在 UI 中选择的资产目录等设置。
const CONFIG_FILE = path.join(APP_DIR, 'app-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {}; }
  catch (e) { return {}; }
}

function writeConfig(patch) {
  const cur = readConfig();
  const next = { ...cur, ...patch };
  const tmp = CONFIG_FILE + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}

// 资产根解析优先级：环境变量 ASSETS_ROOT > app-config.json(assetsRoot) > <项目>/assets。
// 环境变量始终优先，便于运维/CI 覆盖；UI 写入的是配置文件。
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

fs.mkdirSync(ASSETS_ROOT, { recursive: true });
fs.mkdirSync(STAGING_ROOT, { recursive: true });

module.exports = { APP_DIR, ASSETS_ROOT, STAGING_ROOT, ASSETS_ROOT_SOURCE, CONFIG_FILE, readConfig, writeConfig };
