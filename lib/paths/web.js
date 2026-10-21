// 前端构建产物目录。WEB_DIST 可覆盖，默认在项目根的 web/dist。
const path = require('path');
const { APP_DIR, envDir } = require('./system');

const WEB_DIST = envDir('WEB_DIST', path.join(APP_DIR, 'web', 'dist'));

module.exports = { WEB_DIST };
