// lib/paths/models.js
// 模型权重路径：models/ 下的所有权重目录
const path = require('path');
const fs = require('fs');
const { APP_DIR, envDir } = require('./system');

const MODELS_DIR = envDir('MODELS_DIR', path.join(APP_DIR, 'models'));

// 引擎第三方包运行时拉下来的模型权重
const ENGINE_PULLED_DIR = envDir('ENGINE_PULLED_DIR', path.join(MODELS_DIR, 'engine-pulled'));
const MODELSCOPE_CACHE_DIR = envDir('MODELSCOPE_CACHE_DIR', path.join(ENGINE_PULLED_DIR, 'modelscope'));
const HF_HOME_DIR = envDir('HF_HOME_DIR', path.join(ENGINE_PULLED_DIR, 'huggingface'));
const TORCH_HOME_DIR = envDir('TORCH_HOME_DIR', path.join(ENGINE_PULLED_DIR, 'torch'));

const TTS_MODELS_DIR = envDir('TTS_MODELS_DIR', path.join(MODELS_DIR, 'tts'));
const GSV_PRETRAINED_DIR = envDir('GSV_PRETRAINED_DIR', path.join(TTS_MODELS_DIR, 'gpt-sovits'));

const ASR_MODELS_DIR = envDir('ASR_MODELS_DIR', path.join(MODELS_DIR, 'asr'));
const FASTER_WHISPER_DIR = envDir('FASTER_WHISPER_DIR', path.join(ASR_MODELS_DIR, 'faster-whisper'));
const FUNASR_MODELS_DIR = envDir('FUNASR_MODELS_DIR', path.join(ASR_MODELS_DIR, 'funasr'));

const UVR5_WEIGHTS_DIR = envDir('UVR5_WEIGHTS_DIR', path.join(MODELS_DIR, 'separation', 'uvr5'));
const VOCODER_DIR = envDir('VOCODER_DIR', path.join(MODELS_DIR, 'vocoder'));
const SR_MODELS_DIR = envDir('SR_MODELS_DIR', path.join(MODELS_DIR, 'sr'));
const LANG_MODELS_DIR = envDir('LANG_MODELS_DIR', path.join(MODELS_DIR, 'lang'));

// --- GPT-SoVITS 底模：一版一个目录 ------------------------------------------
const LEGACY_BASE_DIRS = {
  v2final: path.join(GSV_PRETRAINED_DIR, 'gsv-v2final'),
  v2pro: path.join(GSV_PRETRAINED_DIR, 'v2Pro'),
};

const BASE_DIRS = {
  v1: path.join(GSV_PRETRAINED_DIR, 'v1'),
  v2: path.join(GSV_PRETRAINED_DIR, 'v2'),
  v2Pro: path.join(GSV_PRETRAINED_DIR, 'v2Pro'),
  v2ProPlus: path.join(GSV_PRETRAINED_DIR, 'v2ProPlus'),
};

function pickWeight(...cands) {
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* 探测失败按不存在处理 */ }
  }
  return cands[0];
}

const S1_V1_FILE = 's1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt';
const S1_V2_FILE = 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt';

const BASE_WEIGHTS_CANONICAL = {
  s1_v1: path.join(BASE_DIRS.v1, S1_V1_FILE),
  s1_v2: path.join(BASE_DIRS.v2, S1_V2_FILE),

  s2G_v1: path.join(BASE_DIRS.v1, 's2G488k.pth'),
  s2D_v1: path.join(BASE_DIRS.v1, 's2D488k.pth'),

  s2G_v2: path.join(BASE_DIRS.v2, 's2G2333k.pth'),
  s2D_v2: path.join(BASE_DIRS.v2, 's2D2333k.pth'),

  s2G_v2Pro: path.join(BASE_DIRS.v2Pro, 's2Gv2Pro.pth'),
  s2D_v2Pro: path.join(BASE_DIRS.v2Pro, 's2Dv2Pro.pth'),

  s2G_v2ProPlus: path.join(BASE_DIRS.v2ProPlus, 's2Gv2ProPlus.pth'),
  s2D_v2ProPlus: path.join(BASE_DIRS.v2ProPlus, 's2Dv2ProPlus.pth'),
};

const BASE_WEIGHTS_LEGACY = {
  s1_v1: path.join(LEGACY_BASE_DIRS.v2final, S1_V1_FILE),
  s1_v2: path.join(LEGACY_BASE_DIRS.v2final, S1_V2_FILE),

  s2G_v1: path.join(LEGACY_BASE_DIRS.v2pro, 's2G488k.pth'),
  s2D_v1: path.join(LEGACY_BASE_DIRS.v2pro, 's2D488k.pth'),

  s2G_v2: path.join(LEGACY_BASE_DIRS.v2final, 's2G2333k.pth'),
  s2D_v2: path.join(LEGACY_BASE_DIRS.v2final, 's2D2333k.pth'),

  s2G_v2Pro: null,
  s2D_v2Pro: null,

  s2G_v2ProPlus: path.join(LEGACY_BASE_DIRS.v2pro, 's2Gv2ProPlus.pth'),
  s2D_v2ProPlus: path.join(LEGACY_BASE_DIRS.v2pro, 's2Dv2ProPlus.pth'),
};

const BASE_WEIGHTS = {};
for (const key of Object.keys(BASE_WEIGHTS_CANONICAL)) {
  const legacy = BASE_WEIGHTS_LEGACY[key];
  BASE_WEIGHTS[key] = legacy
    ? pickWeight(BASE_WEIGHTS_CANONICAL[key], legacy)
    : BASE_WEIGHTS_CANONICAL[key];
}

const PRETRAINED = {
  bigvgan: path.join(VOCODER_DIR, 'bigvgan'),
  cnhubert: path.join(GSV_PRETRAINED_DIR, 'chinese-hubert-base'),
  bert: path.join(GSV_PRETRAINED_DIR, 'chinese-roberta-wwm-ext-large'),
  langdetect: path.join(LANG_MODELS_DIR, 'fast_langdetect'),
  baseV1: BASE_DIRS.v1,
  baseV2: BASE_DIRS.v2,
  sv: path.join(GSV_PRETRAINED_DIR, 'sv'),
  baseV2Pro: BASE_DIRS.v2Pro,
  baseV2ProPlus: BASE_DIRS.v2ProPlus,
  g2pw: path.join(GSV_PRETRAINED_DIR, 'G2PWModel'),
  superRes: path.join(SR_MODELS_DIR, 'ap-bwe', '24kto48k'),
  svCkpt: path.join(GSV_PRETRAINED_DIR, 'sv', 'pretrained_eres2netv2w24s4ep4.ckpt'),
  s2G488k: BASE_WEIGHTS.s2G_v1,
};

module.exports = {
  MODELS_DIR, ENGINE_PULLED_DIR, MODELSCOPE_CACHE_DIR, HF_HOME_DIR, TORCH_HOME_DIR,
  TTS_MODELS_DIR, GSV_PRETRAINED_DIR,
  ASR_MODELS_DIR, FASTER_WHISPER_DIR, FUNASR_MODELS_DIR,
  UVR5_WEIGHTS_DIR, VOCODER_DIR, SR_MODELS_DIR, LANG_MODELS_DIR,
  LEGACY_BASE_DIRS, BASE_DIRS, BASE_WEIGHTS,
  BASE_WEIGHTS_CANONICAL, BASE_WEIGHTS_LEGACY,
  PRETRAINED,
};
