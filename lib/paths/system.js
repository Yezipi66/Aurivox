// lib/paths/system.js
// 系统基础设施：项目根判定、环境变量覆盖助手、运行期数据根解析
const path = require('path');
const fs = require('fs');

// --- 根 ---------------------------------------------------------------------
function detectAppDir(mainFilename) {
  if (process.env.AURIVOX_APP_DIR) return path.resolve(process.env.AURIVOX_APP_DIR);
  const main = mainFilename !== undefined
    ? mainFilename
    : (require.main && require.main.filename);
  if (main && path.basename(main).toLowerCase() === 'server.js') {
    return path.dirname(path.resolve(main));
  }
  // 本文件在 lib/paths/ 下，上一级是 lib/，再上一级是项目根
  return path.resolve(__dirname, '..', '..');
}

const APP_DIR = detectAppDir();
const LIB_DIR = path.join(APP_DIR, 'lib');

// --- 环境变量覆盖助手 -------------------------------------------------------
function envDir(name, fallback) {
  const v = process.env[name];
  return v ? path.resolve(v) : fallback;
}

// --- 运行期数据根 -----------------------------------------------------------
const DATA_DIR = envDir('DATA_DIR', path.join(APP_DIR, 'data'));

function dataOrRoot(envName, name) {
  const override = process.env[envName];
  if (override) return path.resolve(override);
  const inData = path.join(DATA_DIR, name);
  const inRoot = path.join(APP_DIR, name);
  try {
    if (fs.existsSync(inData)) return inData;
    if (fs.existsSync(inRoot)) return inRoot;
  } catch (e) { /* 探测失败时按全新安装处理 */ }
  return inData;
}

// --- 配置文件 ---------------------------------------------------------------
const CONFIG_FILE = dataOrRoot('APP_CONFIG_FILE', 'app-config.json');

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

module.exports = {
  detectAppDir, APP_DIR, LIB_DIR, DATA_DIR,
  CONFIG_FILE, readConfig, writeConfig,
  envDir, dataOrRoot,
};
