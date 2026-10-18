// lib/paths/runtimeData.js
// 运行期数据路径：音色注册表、配方、画布、配置文件
const path = require('path');
const { DATA_DIR, dataOrRoot, envDir } = require('./system');

// 读音词典
const PRON_LEXICON_DIR = envDir('PRON_LEXICON_DIR', path.join(DATA_DIR, 'pron_lexicon'));

// 音色注册表
const VOICES_JSON = dataOrRoot('VOICES_JSON', 'voices.json');

// 音色相关目录
const VOICES_DIR = dataOrRoot('VOICES_DIR', 'voices');
const CUSTOM_REF_DIR = envDir('CUSTOM_REF_DIR', path.join(VOICES_DIR, 'custom_refs'));

// voices.json 的轮转备份
const BACKUP_DIR = dataOrRoot('BACKUP_DIR', 'backups');

// 配方：可复用预设，平铺存储为 recipe_{voiceId}_{name}.json
const RECIPES_DIR = dataOrRoot('RECIPES_DIR', 'recipes');

// 画布：流程图与运行状态
const FLOWGRAPH_DIR = dataOrRoot('FLOWGRAPH_DIR', 'flowgraph');

// 界面记忆文件
const ADVANCED_PARAMS_FILE = dataOrRoot('ADVANCED_PARAMS_FILE', 'advanced_params.json');
const TRAINING_DEFAULTS_FILE = dataOrRoot('TRAINING_DEFAULTS_FILE', 'training_defaults.json');

// 运行期数据的规范名录
const DATA_ITEMS = Object.freeze([
  { name: 'app-config.json', isDir: false, env: 'APP_CONFIG_FILE', desc: '本地配置（资产根等）' },
  { name: 'voices.json', isDir: false, env: 'VOICES_JSON', desc: '音色注册表' },
  { name: 'advanced_params.json', isDir: false, env: 'ADVANCED_PARAMS_FILE', desc: '界面记忆：高级参数上次拧到哪' },
  { name: 'training_defaults.json', isDir: false, env: 'TRAINING_DEFAULTS_FILE', desc: '训练默认值' },
  { name: 'voices', isDir: true, env: 'VOICES_DIR', desc: '全局参考音频导入暂存区' },
  { name: 'backups', isDir: true, env: 'BACKUP_DIR', desc: '注册表轮转备份' },
  { name: 'recipes', isDir: true, env: 'RECIPES_DIR', desc: '配方预设' },
  { name: 'flowgraph', isDir: true, env: 'FLOWGRAPH_DIR', desc: '画布的图与运行状态' },
]);

module.exports = {
  PRON_LEXICON_DIR, VOICES_JSON, VOICES_DIR, CUSTOM_REF_DIR,
  BACKUP_DIR, RECIPES_DIR, FLOWGRAPH_DIR,
  ADVANCED_PARAMS_FILE, TRAINING_DEFAULTS_FILE,
  DATA_ITEMS,
};
