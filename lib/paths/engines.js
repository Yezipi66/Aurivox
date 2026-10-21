// lib/paths/engines.js
// 引擎相关路径：engines/、pipeline/、训练与推理目录
const path = require('path');
const { APP_DIR, LIB_DIR, envDir } = require('./system');

const VENDOR_DIR = path.join(APP_DIR, 'vendor');
const ENGINES_DIR = envDir('ENGINES_DIR', path.join(APP_DIR, 'engines'));
const PIPELINE_DIR = envDir('PIPELINE_DIR', path.join(APP_DIR, 'pipeline'));
const TRAINING_DIR = path.join(LIB_DIR, 'training');
const INFERENCE_DIR = path.join(LIB_DIR, 'inference');

// --- pipeline/：引擎无关的数据处理 -------------------------------------------
const UVR5_DIR = envDir('UVR5_DIR', path.join(PIPELINE_DIR, 'uvr5'));
const ASR_DIR = envDir('ASR_DIR', path.join(PIPELINE_DIR, 'asr'));
const SLICER_DIR = envDir('SLICER_DIR', path.join(PIPELINE_DIR, 'slicer'));

// --- engines/：一个目录一个 TTS 引擎 -----------------------------------------
const GSV_DIR = envDir('GSV_DIR', path.join(ENGINES_DIR, 'gpt-sovits'));
const GSV_CODE_DIR = envDir('GSV_CODE_DIR', path.join(GSV_DIR, 'gsv_code'));
const GSV_INFER_DIR = envDir('GSV_INFER_DIR', path.join(GSV_DIR, 'infer'));
const GSV_TRAIN_DIR = envDir('GSV_TRAIN_DIR', path.join(GSV_DIR, 'train'));

module.exports = {
  VENDOR_DIR, ENGINES_DIR, PIPELINE_DIR, TRAINING_DIR, INFERENCE_DIR,
  UVR5_DIR, ASR_DIR, SLICER_DIR,
  GSV_DIR, GSV_CODE_DIR, GSV_INFER_DIR, GSV_TRAIN_DIR,
};
