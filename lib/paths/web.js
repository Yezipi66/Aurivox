// lib/paths/web.js
// 前端产物路径
const path = require('path');
const { APP_DIR, envDir } = require('./system');

const WEB_DIST = envDir('WEB_DIST', path.join(APP_DIR, 'web', 'dist'));

module.exports = { WEB_DIST };
