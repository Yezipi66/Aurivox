// ===========================================================================
//  PATHS — 全项目唯一的目录/文件位置权威
// ===========================================================================
//
// 规矩（三条，请勿绕过）：
//
//   1. 任何业务目录名（outputs / voices / backups / recipes / pretrained /
//      uvr5_weights / flowgraph 等）只允许在本文件里出现一次。其它模块一律
//      require 本文件取常量，不得自行拼接业务目录名。守卫测试
//      lib/paths.node.test.js 会机器检查这一条。
//
//   2. 本文件里每个常量的初值等于该路径当前的真实位置。本轮只做收口，不搬
//      任何文件，因此行为零变化。日后要搬某个目录，改本文件一行即可，不必
//      再翻十几个文件。
//
//   3. 每个常量都可被同名环境变量覆盖，便于运维、持续集成与测试。覆盖值一律
//      经 path.resolve 处理，允许传入相对路径。
//
// 运行期数据（音色注册表、配方、备份、画布、若干配置文件）自本轮起统一位于
// data/ 之下。为使既有安装在「只更新代码、尚未搬迁数据」时仍能正常工作，每一项
// 都按 dataOrRoot() 的三档顺序解析，详见该函数上方的说明。
//
const path = require('path');
const fs = require('fs');

// --- 根 ---------------------------------------------------------------------
//
// 项目根的判定必须以「入口 server.js 所在的目录」为准，不能简单地取
// path.resolve(__dirname, '..')。
//
// 原因：lib/ 可能是一个指向别处的符号链接（Windows 上是 junction）。Node 默认
// 会把模块路径解析到链接的真实目标，于是本文件的 __dirname 会落在被链接的那份
// 仓库里，上一级自然也就成了那份仓库的根，而不是实际运行的那个目录。
// lib/__testsupport__/brokerHarness.js 正是这么搭测试环境的：只复制 server.js
// 与 package.json，lib/ web/ node_modules/ 全部链接回仓库。收口前 server.js 用
// 自己的 __dirname 定根，所以一直是对的；路径挪进本文件后若不做这层判定，
// 服务端就会去错误的目录读写 voices.json 等运行期文件。
//
// 判定顺序：环境变量 > 入口脚本是 server.js 时取其所在目录 > 本文件的上一级。
// 第三档服务于单元测试等直接 require 本文件的场合，此时没有 server.js 入口，
// 取仓库根正确。
// 入口脚本路径可显式传入，仅为便于守卫测试；生产调用不带参数。
function detectAppDir(mainFilename) {
  if (process.env.AURIVOX_APP_DIR) return path.resolve(process.env.AURIVOX_APP_DIR);
  const main = mainFilename !== undefined
    ? mainFilename
    : (require.main && require.main.filename);
  if (main && path.basename(main).toLowerCase() === 'server.js') {
    return path.dirname(path.resolve(main));
  }
  return path.resolve(__dirname, '..');
}

const APP_DIR = detectAppDir();

// 环境变量覆盖助手：指定名称有值则采用（解析为绝对路径），否则采用默认值。
function envDir(name, fallback) {
  const v = process.env[name];
  return v ? path.resolve(v) : fallback;
}

// --- 运行期数据根 -----------------------------------------------------------
const DATA_DIR = envDir('DATA_DIR', path.join(APP_DIR, 'data'));

// 运行期数据的位置解析。按顺序取第一个成立者：
//
//   1. 同名环境变量（运维、持续集成与测试的逃生口）
//   2. data/<名称>  —— 若已存在，即为权威位置
//   3. <项目根>/<名称> —— 若已存在，说明是尚未搬迁数据的既有安装，继续沿用
//   4. data/<名称>  —— 全新安装的落点
//
// 第 3 档是保护条款：用户可能只更新了代码而没跑数据迁移。此时若径直改用 data/，
// 服务端会在空目录上重建注册表，用户的音色、配方、画布会一并「消失」。有了这一
// 档，未迁移的安装原样继续工作；跑完迁移脚本后根上不再有这些条目，自动切到 data/。
// 第 2 档先于第 3 档，是为使「手工把文件放进 data/」也能立刻生效。
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
// 本地配置文件（不依赖 dotenv）：持久化用户在界面中选择的资产目录等设置。
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

// --- 资产与暂存 -------------------------------------------------------------
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

// 资产内部的子目录名。按 <ASSETS_ROOT>/<角色>/<该名称> 拼路径使用，
// 与下方 CUSTOM_REF_DIR（全局导入暂存区）并非同一位置，请勿混用。
const CUSTOM_REFS_DIRNAME = 'custom_refs';

// --- 运行期数据 -------------------------------------------------------------
// 全部位于 data/ 之下（DATA_DIR 与 dataOrRoot 见本文件上方）。

// 读音词典：项目中最早采用 data/ 约定之处。
const PRON_LEXICON_DIR = envDir('PRON_LEXICON_DIR', path.join(DATA_DIR, 'pron_lexicon'));

// 音色注册表。
//
// 这是一份「可再生的运行期缓存」，而非需要人工维护的配置：
// server.js 的 runFullAssetScan() 以 assets/ 目录的实际扫描结果为准重建它——
// 磁盘上不存在的 id 会被删除，存在的则按 meta.json 覆写那四个字段。
// 因此它不随源码包分发，首次启动时由资产扫描自动生成。
//
// （曾存在 lib/voices.json 这份过期快照，无任何代码引用，已删除。）
const VOICES_JSON = dataOrRoot('VOICES_JSON', 'voices.json');

// 音色相关目录：VOICES_DIR 下设全局参考音频导入暂存区。
const VOICES_DIR = dataOrRoot('VOICES_DIR', 'voices');
const CUSTOM_REF_DIR = envDir('CUSTOM_REF_DIR', path.join(VOICES_DIR, CUSTOM_REFS_DIRNAME));

// voices.json 的轮转备份。
const BACKUP_DIR = dataOrRoot('BACKUP_DIR', 'backups');

// 配方：可复用预设，平铺存储为 recipe_{voiceId}_{name}.json。
const RECIPES_DIR = dataOrRoot('RECIPES_DIR', 'recipes');

// 画布：流程图与运行状态（其下为 graphs/ 与 state/）。
// server.js 以 rootDir 显式传入 createFlowgraphService，不依赖 ctx 中是否有 DATA_DIR。
const FLOWGRAPH_DIR = dataOrRoot('FLOWGRAPH_DIR', 'flowgraph');

// 可被外部 JSON 覆盖的默认值文件。服务端会写回这两个文件，
// 因此迁移必须搬走原件而非复制，否则用户已调整的值会分叉。
const ADVANCED_PARAMS_FILE = dataOrRoot('ADVANCED_PARAMS_FILE', 'advanced_params.json');
const TRAINING_DEFAULTS_FILE = dataOrRoot('TRAINING_DEFAULTS_FILE', 'training_defaults.json');

// 运行期数据的规范名录：迁移脚本与守卫测试都以此为准，避免两处各写一份。
// isDir 决定迁移时按目录合并还是按文件搬运。
const DATA_ITEMS = Object.freeze([
  { name: 'app-config.json', isDir: false, env: 'APP_CONFIG_FILE', desc: '本地配置（资产根等）' },
  { name: 'voices.json', isDir: false, env: 'VOICES_JSON', desc: '音色注册表' },
  { name: 'advanced_params.json', isDir: false, env: 'ADVANCED_PARAMS_FILE', desc: '高级参数默认值' },
  { name: 'training_defaults.json', isDir: false, env: 'TRAINING_DEFAULTS_FILE', desc: '训练默认值' },
  { name: 'voices', isDir: true, env: 'VOICES_DIR', desc: '全局参考音频导入暂存区' },
  { name: 'backups', isDir: true, env: 'BACKUP_DIR', desc: '注册表轮转备份' },
  { name: 'recipes', isDir: true, env: 'RECIPES_DIR', desc: '配方预设' },
  { name: 'flowgraph', isDir: true, env: 'FLOWGRAPH_DIR', desc: '画布的图与运行状态' },
]);

// --- 产物 -------------------------------------------------------------------
// 纪律：outputs/ 仅存放推理结果。各来源物理隔离，历史记录互不混淆（2026-07-07 确定）。
const OUTPUT_DIR = envDir('OUTPUT_DIR', path.join(APP_DIR, 'outputs'));
const GENERATE_DIR = path.join(OUTPUT_DIR, 'generate');
const COMPARE_DIR = path.join(OUTPUT_DIR, 'comparerefs');
const BROKER_DIR = path.join(OUTPUT_DIR, 'broker');
const FLOWGRAPH_OUTPUT_DIR = path.join(OUTPUT_DIR, 'flowgraph');

// 产物来源名到目录的映射。server.js 的 OUTPUT_ROOTS 由此派生，
// 使"新增一个产物来源"只需在此增加一行。
const OUTPUT_ROOTS = {
  generate: GENERATE_DIR,
  comparerefs: COMPARE_DIR,
  broker: BROKER_DIR,
};

// --- 前端 -------------------------------------------------------------------
// 前端运行的是打包产物；修改前端后若未执行 npm run build，页面不会发生变化。
const WEB_DIST = envDir('WEB_DIST', path.join(APP_DIR, 'web', 'dist'));

// --- 训练与推理的代码及权重位置 ----------------------------------------------
// 第三方代码集中于顶层 vendor/，第一层按工作流环节划分（uvr5 / asr / slicer /
// tts），引擎名放在第二层。权重仍在旧位置，下一轮迁入顶层 models/。
const LIB_DIR = path.join(APP_DIR, 'lib');
const VENDOR_DIR = path.join(APP_DIR, 'vendor');
const TRAINING_DIR = path.join(LIB_DIR, 'training');
const INFERENCE_DIR = path.join(LIB_DIR, 'inference');

// --- 第三方代码：按工作流环节分 ---------------------------------------------
// 人声分离（Ultimate Vocal Remover 5）
const UVR5_DIR = envDir('UVR5_DIR', path.join(VENDOR_DIR, 'uvr5'));
// 语音识别（faster-whisper / FunASR 的封装脚本）
const ASR_DIR = envDir('ASR_DIR', path.join(VENDOR_DIR, 'asr'));
// 音频切分
const SLICER_DIR = envDir('SLICER_DIR', path.join(VENDOR_DIR, 'slicer'));

// TTS 环节，引擎名在第二层。
const TTS_VENDOR_DIR = path.join(VENDOR_DIR, 'tts');
const GSV_DIR = envDir('GSV_DIR', path.join(TTS_VENDOR_DIR, 'gpt-sovits'));
// 上游 GPT-SoVITS 源码（第三方代码，请勿修改）。
// 目录名 gsv_code 同时是 Python 包名，全树 106 处 `from gsv_code...` 依赖它，
// 因此只能整体搬家，不能改名 —— 改名等于改 106 处第三方 import。
const GSV_CODE_DIR = envDir('GSV_CODE_DIR', path.join(GSV_DIR, 'gsv_code'));
// 推理运行时。我方编写的进程入口 lib/inference/infer_server.py 仍留在 lib 下，
// 由 INFERENCE_DIR 指向。
const GSV_INFER_DIR = envDir('GSV_INFER_DIR', path.join(GSV_DIR, 'infer'));
// 上游训练脚本。注意本项目实际调用的是 GSV_CODE_DIR 下的同名脚本（见
// lib/training/steps/train.js），此处两个文件目前无人调用，待核实后再决定去留。
const GSV_TRAIN_DIR = envDir('GSV_TRAIN_DIR', path.join(GSV_DIR, 'train'));

// --- 权重 models/ -----------------------------------------------------------
// 模型权重一律位于项目根的 models/ 之下，不进 git，不与代码混放。
// 第一层是能力域（tts / asr / separation / vocoder / sr / lang），第二层才是
// 引擎名或架构名 —— 与 engines/ 的分层规则一致（引擎契约 C8）。
//
// 目录名不得携带语义（C8.1）：uvr5 的架构目录刻意取名 vr / roformer / mdx，
// 避开 bs_roformer、DeReverb 这类会被推理代码拿去做路径子串匹配的字样。
const MODELS_DIR = envDir('MODELS_DIR', path.join(APP_DIR, 'models'));

const TTS_MODELS_DIR = envDir('TTS_MODELS_DIR', path.join(MODELS_DIR, 'tts'));
const GSV_PRETRAINED_DIR = envDir('GSV_PRETRAINED_DIR', path.join(TTS_MODELS_DIR, 'gpt-sovits'));

// ASR：两个引擎平级，各自一层，不摊平在 models/asr/ 下。
const ASR_MODELS_DIR = envDir('ASR_MODELS_DIR', path.join(MODELS_DIR, 'asr'));
const FASTER_WHISPER_DIR = envDir('FASTER_WHISPER_DIR', path.join(ASR_MODELS_DIR, 'faster-whisper'));
const FUNASR_MODELS_DIR = envDir('FUNASR_MODELS_DIR', path.join(ASR_MODELS_DIR, 'funasr'));

// 人声分离：第二层是引擎，第三层是架构。
const UVR5_WEIGHTS_DIR = envDir('UVR5_WEIGHTS_DIR',
  path.join(MODELS_DIR, 'separation', 'uvr5'));

const VOCODER_DIR = envDir('VOCODER_DIR', path.join(MODELS_DIR, 'vocoder'));
const SR_MODELS_DIR = envDir('SR_MODELS_DIR', path.join(MODELS_DIR, 'sr'));
const LANG_MODELS_DIR = envDir('LANG_MODELS_DIR', path.join(MODELS_DIR, 'lang'));

// 具体权重子目录。业务代码一律从这里取，不得自行拼接目录名。
const PRETRAINED = {
  bigvgan: path.join(VOCODER_DIR, 'bigvgan'),
  cnhubert: path.join(GSV_PRETRAINED_DIR, 'chinese-hubert-base'),
  bert: path.join(GSV_PRETRAINED_DIR, 'chinese-roberta-wwm-ext-large'),
  langdetect: path.join(LANG_MODELS_DIR, 'fast_langdetect'),
  gsvV2Final: path.join(GSV_PRETRAINED_DIR, 'gsv-v2final'),
  sv: path.join(GSV_PRETRAINED_DIR, 'sv'),
  v2Pro: path.join(GSV_PRETRAINED_DIR, 'v2Pro'),
  g2pw: path.join(GSV_PRETRAINED_DIR, 'G2PWModel'),
  superRes: path.join(SR_MODELS_DIR, 'ap-bwe', '24kto48k'),
  svCkpt: path.join(GSV_PRETRAINED_DIR, 'sv', 'pretrained_eres2netv2w24s4ep4.ckpt'),
  s2G488k: path.join(GSV_PRETRAINED_DIR, 'v2Pro', 's2G488k.pth'),
};

// --- 缓存 cache/ ------------------------------------------------------------
// 可再生产物统一落在项目根的 cache/ 之下，不进 git，删掉只是变慢不会变坏。
// 迁此之前它们散落在四处：%TEMP%\numba_cache、相对当前工作目录的 TEMP\ja\、
// 上游代码目录旁、以及 %USERPROFILE%\.cache（在项目之外）。
const CACHE_DIR = envDir('CACHE_DIR', path.join(APP_DIR, 'cache'));
const CACHE = {
  numba: path.join(CACHE_DIR, 'numba'),
  hf: path.join(CACHE_DIR, 'hf'),
  modelscope: path.join(CACHE_DIR, 'modelscope'),
  torch: path.join(CACHE_DIR, 'torch'),
  dict: path.join(CACHE_DIR, 'dict'),
};

// --- 启动时需要存在的目录 ---------------------------------------------------
// 与收口前 server.js 中的建目录集合逐项一致，不多建也不少建。
// DATA_DIR 为本轮新增：voices.json 与 app-config.json 现写在其中，
// 而写入方（writeConfig、VoicesStore）都假定所在目录已存在。
const RUNTIME_DIRS = [
  DATA_DIR,
  OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR,
  VOICES_DIR, BACKUP_DIR, RECIPES_DIR, ASSETS_ROOT,
];

function ensureRuntimeDirs() {
  for (const d of RUNTIME_DIRS) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// 收口前 paths.js 在加载时即创建这两个目录，此行为保持不变。
fs.mkdirSync(ASSETS_ROOT, { recursive: true });
fs.mkdirSync(STAGING_ROOT, { recursive: true });
// data/ 需在加载时就存在：writeConfig 会往 CONFIG_FILE 所在目录写临时文件，
// 而该调用可能发生在 ensureRuntimeDirs 之前。
fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });

// --- 遗留位置备忘 -----------------------------------------------------------
// 权重迁入 models/、缓存迁入 cache/ 之后，本表已无条目。保留这个空表而不删除，
// 是因为 r12c 起还要迁运行时（tools/runtime/ 与 vendor/{ffmpeg,micromamba}），
// 届时仍按同一格式登记：current 是今天的位置，target 是本该在的位置。
const LEGACY_LOCATIONS = Object.freeze({});

module.exports = {
  // 根与配置
  APP_DIR, LIB_DIR, DATA_DIR, CONFIG_FILE, readConfig, writeConfig,
  detectAppDir,
  // 资产
  ASSETS_ROOT, ASSETS_ROOT_SOURCE, STAGING_ROOT, CUSTOM_REFS_DIRNAME,
  // 运行期数据
  VOICES_JSON, VOICES_DIR, CUSTOM_REF_DIR, BACKUP_DIR, RECIPES_DIR,
  PRON_LEXICON_DIR, FLOWGRAPH_DIR,
  ADVANCED_PARAMS_FILE, TRAINING_DEFAULTS_FILE,
  DATA_ITEMS, dataOrRoot,
  // 产物
  OUTPUT_DIR, GENERATE_DIR, COMPARE_DIR, BROKER_DIR, FLOWGRAPH_OUTPUT_DIR, OUTPUT_ROOTS,
  // 前端
  WEB_DIST,
  // 训练、推理与权重
  TRAINING_DIR, INFERENCE_DIR, VENDOR_DIR,
  GSV_DIR, GSV_CODE_DIR, GSV_INFER_DIR, GSV_TRAIN_DIR,
  UVR5_DIR, ASR_DIR, SLICER_DIR,
  // 权重
  MODELS_DIR, TTS_MODELS_DIR, GSV_PRETRAINED_DIR,
  ASR_MODELS_DIR, FASTER_WHISPER_DIR, FUNASR_MODELS_DIR,
  UVR5_WEIGHTS_DIR, VOCODER_DIR, SR_MODELS_DIR, LANG_MODELS_DIR,
  PRETRAINED,
  // 缓存
  CACHE_DIR, CACHE,
  // 启动
  RUNTIME_DIRS, ensureRuntimeDirs,
  // 备忘
  LEGACY_LOCATIONS,
};
