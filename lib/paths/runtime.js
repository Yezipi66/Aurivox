// lib/paths/runtime.js
// 启动时需要存在的目录
const fs = require('fs');
const { DATA_DIR, ASSETS_ROOT } = require('./system');
const { ASSETS_ROOT: _ASSETS_ROOT } = require('./assets');
const {
  OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR,
} = require('./outputs');
const { VOICES_DIR, BACKUP_DIR, RECIPES_DIR } = require('./runtimeData');

// ASSETS_ROOT 与 STAGING_ROOT 在 system.js 中已创建
const STAGING_ROOT = require('./assets').STAGING_ROOT;

const RUNTIME_DIRS = [
  DATA_DIR,
  OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR,
  VOICES_DIR, BACKUP_DIR, RECIPES_DIR, _ASSETS_ROOT,
];

function ensureRuntimeDirs() {
  for (const d of RUNTIME_DIRS) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

module.exports = { RUNTIME_DIRS, ensureRuntimeDirs };
