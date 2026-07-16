/**
 * 训练配置加载器
 * 读取 training_defaults.json + model_paths.json
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', 'training_defaults.json');
const MODEL_PATHS_FILE = path.join(__dirname, 'model_paths.json');

let cachedConfig = null;
let cachedModelPaths = null;

function loadTrainingConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.log('[TRAINING] training_defaults.json not found, using built-in defaults');
      return getBuiltInDefaults();
    }
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    cachedConfig = data;
    return data;
  } catch (e) {
    console.error('[TRAINING] Failed to load config:', e.message);
    return getBuiltInDefaults();
  }
}

function loadModelPaths() {
  if (cachedModelPaths) return cachedModelPaths;
  try {
    if (!fs.existsSync(MODEL_PATHS_FILE)) {
      console.log('[TRAINING] model_paths.json not found');
      return null;
    }
    const data = JSON.parse(fs.readFileSync(MODEL_PATHS_FILE, 'utf-8'));
    cachedModelPaths = data;
    return data;
  } catch (e) {
    console.error('[TRAINING] Failed to load model paths:', e.message);
    return null;
  }
}

function getBuiltInDefaults() {
  return {
    version: '1.0',
    steps: {
      denoise: {
        enabled_by_default: false,
        params: { model: 'mdx-net', threshold: 0.5 },
      },
      slice: {
        enabled_by_default: false,
        params: { min_duration_sec: 3, max_duration_sec: 15, silence_threshold_db: -40, min_silence_sec: 0.5 },
      },
      asr: {
        enabled_by_default: false,
        params: {
          model: 'faster-whisper-large-v3-turbo',
          language_detect: false,
          // All languages route to faster-whisper (DAMO/FunASR retired).
          engines: {
            zh:      { engine: 'faster-whisper' },
            yue:     { engine: 'faster-whisper' },
            ja:      { engine: 'faster-whisper' },
            ko:      { engine: 'faster-whisper' },
            en:      { engine: 'faster-whisper' },
            default: { engine: 'faster-whisper' },
          },
        },
      },
    },
    // Patch #10 — asymmetric defaults. S1 (GPT) adapts semantic rhythm/prosody
    // and overfits earlier on small datasets (RVC-Boss issue #176: overtraining
    // GPT causes missing/dropped text); S2 (SoVITS) needs more epochs to converge
    // on timbre/acoustics. The old symmetric 20/20 was an interface convenience,
    // not a real balance. Save intervals are chosen so the FINAL epoch always
    // lands on a checkpoint: S1 every 4 (8 % 4 == 0), S2 every 5 (25 % 5 == 0).
    training: {
      gpt_epochs: 8,
      sovits_epochs: 25,
      s1_save_every_n_epoch: 4,
      s2_save_every_n_epoch: 5,
      batch_size: 'auto',
      learning_rate: 'default',
    },
  };
}

function reloadConfig() {
  cachedConfig = null;
  cachedModelPaths = null;
  return loadTrainingConfig();
}

module.exports = { loadTrainingConfig, loadModelPaths, reloadConfig };
