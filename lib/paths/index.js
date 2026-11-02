// 路径常量的统一导出入口：把 lib/paths/ 下的子模块按用途分组汇成一份。
// 每个路径的来源（环境变量、配置文件、项目根）由对应的子模块决定，本文件不重新推导。
// 加载时有副作用：建好 ASSETS_ROOT、STAGING_ROOT 与 CONFIG_FILE 所在目录。

const fs = require('fs');
const path = require('path');

const system = require('./system');
const assets = require('./assets');
const runtimeData = require('./runtimeData');
const outputs = require('./outputs');
const engines = require('./engines');
const models = require('./models');
const cache = require('./cache');
const web = require('./web');
const runtime = require('./runtime');

// 加载时创建三个目录：资产根、暂存根、配置文件所在目录。
fs.mkdirSync(assets.ASSETS_ROOT, { recursive: true });
fs.mkdirSync(assets.STAGING_ROOT, { recursive: true });
fs.mkdirSync(path.dirname(system.CONFIG_FILE), { recursive: true });

// 遗留位置备忘表。内容为空，表示当前没有任何待迁移的路径。
const LEGACY_LOCATIONS = Object.freeze({});

module.exports = {
  // 根与配置
  APP_DIR: system.APP_DIR,
  LIB_DIR: system.LIB_DIR,
  DATA_DIR: system.DATA_DIR,
  CONFIG_FILE: system.CONFIG_FILE,
  readConfig: system.readConfig,
  writeConfig: system.writeConfig,
  detectAppDir: system.detectAppDir,
  dataOrRoot: system.dataOrRoot,

  // 资产
  ASSETS_ROOT: assets.ASSETS_ROOT,
  ASSETS_ROOT_SOURCE: assets.ASSETS_ROOT_SOURCE,
  STAGING_ROOT: assets.STAGING_ROOT,
  CUSTOM_REFS_DIRNAME: assets.CUSTOM_REFS_DIRNAME,

  // 运行期数据
  VOICES_JSON: runtimeData.VOICES_JSON,
  VOICES_DIR: runtimeData.VOICES_DIR,
  CUSTOM_REF_DIR: runtimeData.CUSTOM_REF_DIR,
  BACKUP_DIR: runtimeData.BACKUP_DIR,
  RECIPES_DIR: runtimeData.RECIPES_DIR,
  PRON_LEXICON_DIR: runtimeData.PRON_LEXICON_DIR,
  FLOWGRAPH_DIR: runtimeData.FLOWGRAPH_DIR,
  ADVANCED_PARAMS_FILE: runtimeData.ADVANCED_PARAMS_FILE,
  TRAINING_DEFAULTS_FILE: runtimeData.TRAINING_DEFAULTS_FILE,
  DATA_ITEMS: runtimeData.DATA_ITEMS,

  // 产物
  OUTPUT_DIR: outputs.OUTPUT_DIR,
  GENERATE_DIR: outputs.GENERATE_DIR,
  COMPARE_DIR: outputs.COMPARE_DIR,
  BROKER_DIR: outputs.BROKER_DIR,
  FLOWGRAPH_OUTPUT_DIR: outputs.FLOWGRAPH_OUTPUT_DIR,
  OUTPUT_ROOTS: outputs.OUTPUT_ROOTS,

  // 前端
  WEB_DIST: web.WEB_DIST,

  // 训练、推理与权重
  TRAINING_DIR: engines.TRAINING_DIR,
  INFERENCE_DIR: engines.INFERENCE_DIR,
  VENDOR_DIR: engines.VENDOR_DIR,
  ENGINE_PULLED_DIR: models.ENGINE_PULLED_DIR,
  MODELSCOPE_CACHE_DIR: models.MODELSCOPE_CACHE_DIR,
  HF_HOME_DIR: models.HF_HOME_DIR,
  TORCH_HOME_DIR: models.TORCH_HOME_DIR,
  ENGINES_DIR: engines.ENGINES_DIR,
  PIPELINE_DIR: engines.PIPELINE_DIR,
  GSV_DIR: engines.GSV_DIR,
  GSV_CODE_DIR: engines.GSV_CODE_DIR,
  GSV_INFER_DIR: engines.GSV_INFER_DIR,
  GSV_TRAIN_DIR: engines.GSV_TRAIN_DIR,
  UVR5_DIR: engines.UVR5_DIR,
  ASR_DIR: engines.ASR_DIR,
  SLICER_DIR: engines.SLICER_DIR,

  // 权重
  MODELS_DIR: models.MODELS_DIR,
  TTS_MODELS_DIR: models.TTS_MODELS_DIR,
  GSV_PRETRAINED_DIR: models.GSV_PRETRAINED_DIR,
  ASR_MODELS_DIR: models.ASR_MODELS_DIR,
  FASTER_WHISPER_DIR: models.FASTER_WHISPER_DIR,
  FUNASR_MODELS_DIR: models.FUNASR_MODELS_DIR,
  UVR5_WEIGHTS_DIR: models.UVR5_WEIGHTS_DIR,
  VOCODER_DIR: models.VOCODER_DIR,
  SR_MODELS_DIR: models.SR_MODELS_DIR,
  LANG_MODELS_DIR: models.LANG_MODELS_DIR,
  PRETRAINED: models.PRETRAINED,
  BASE_DIRS: models.BASE_DIRS,
  BASE_WEIGHTS: models.BASE_WEIGHTS,
  LEGACY_BASE_DIRS: models.LEGACY_BASE_DIRS,
  BASE_WEIGHTS_CANONICAL: models.BASE_WEIGHTS_CANONICAL,
  BASE_WEIGHTS_LEGACY: models.BASE_WEIGHTS_LEGACY,

  // 缓存
  CACHE_DIR: cache.CACHE_DIR,
  CACHE: cache.CACHE,
  UV_CACHE_DIR: cache.UV_CACHE_DIR,

  // 启动
  RUNTIME_DIRS: runtime.RUNTIME_DIRS,
  ensureRuntimeDirs: runtime.ensureRuntimeDirs,

  // 备忘
  LEGACY_LOCATIONS,
};
