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

// 服务端会写回这两个文件，因此迁移必须搬走原件而非复制，否则用户已调整的值会分叉。
//
// ⚠ 这两个文件性质**不同**，别被放在一起误导：
//   · training_defaults.json —— 真正的出厂默认值，随发行包发。
//   · advanced_params.json  —— **界面记忆**：上次在界面上拧到哪。
//     它不是默认值表（默认值的唯一产地是引擎名片，契约 C11；详见
//     lib/advancedParams.js 顶部 2026-08-23 划的界）。
//     ⭐ 因此它**不进 git、不进发行包**（2026-08-25）：盘上没有它时每个键都
//        退回名片，那才是正确状态；发出去等于把一台机器的状态变成所有人的默认值。
const ADVANCED_PARAMS_FILE = dataOrRoot('ADVANCED_PARAMS_FILE', 'advanced_params.json');
const TRAINING_DEFAULTS_FILE = dataOrRoot('TRAINING_DEFAULTS_FILE', 'training_defaults.json');

// 运行期数据的规范名录：迁移脚本与守卫测试都以此为准，避免两处各写一份。
// isDir 决定迁移时按目录合并还是按文件搬运。
const DATA_ITEMS = Object.freeze([
  { name: 'app-config.json', isDir: false, env: 'APP_CONFIG_FILE', desc: '本地配置（资产根等）' },
  { name: 'voices.json', isDir: false, env: 'VOICES_JSON', desc: '音色注册表' },
  { name: 'advanced_params.json', isDir: false, env: 'ADVANCED_PARAMS_FILE', desc: '界面记忆：高级参数上次拧到哪（不是默认值表）' },
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

// --- 顶层目录的角色（r12c 冻结，判据见 docs/ENGINE_CONTRACT.md §2）----------
//
// 顶层按「换 TTS 引擎时会不会跟着换」分，第二层才按功能分：
//
//   engines/   换引擎时**跟着换**。一个目录一个引擎，加引擎只碰这里。
//              engines/ 下的目录数 == 支持的引擎数，这个数字必须有意义。
//   pipeline/  换引擎时**不换**的第三方代码：打标 / 分离 / 切片，所有引擎共用。
//   vendor/    第三方**成品**：我们没改过一行，下下来原封不动就能跑
//              （ffmpeg / micromamba / python / node）。
//   models/    全部权重。
//   data/      用户编辑过、删了要不回来的东西。
//   lib/ web/  我们自己写的，上游根本不知道它存在。
//
// 判物证：`LOCAL-CHANGES.md` 在哪，哪就不是 vendor/ —— 有这个文件说明我们
// 改过上游，改过就要维护，就归 engines/ 或 pipeline/。
const LIB_DIR = path.join(APP_DIR, 'lib');
const VENDOR_DIR = path.join(APP_DIR, 'vendor');
const ENGINES_DIR = envDir('ENGINES_DIR', path.join(APP_DIR, 'engines'));
const PIPELINE_DIR = envDir('PIPELINE_DIR', path.join(APP_DIR, 'pipeline'));
const TRAINING_DIR = path.join(LIB_DIR, 'training');
const INFERENCE_DIR = path.join(LIB_DIR, 'inference');

// --- pipeline/：引擎无关的数据处理，按工作流环节分 ---------------------------
// 这三个是训练**任何**引擎都要用的工具，不属于任何一个引擎 —— 所以不在
// engines/ 下。加引擎的人不该看见它们。
// 人声分离（Ultimate Vocal Remover 5）
const UVR5_DIR = envDir('UVR5_DIR', path.join(PIPELINE_DIR, 'uvr5'));
// 语音识别（faster-whisper / FunASR 的封装脚本）
const ASR_DIR = envDir('ASR_DIR', path.join(PIPELINE_DIR, 'asr'));
// 音频切分
const SLICER_DIR = envDir('SLICER_DIR', path.join(PIPELINE_DIR, 'slicer'));

// --- engines/：一个目录一个 TTS 引擎 ----------------------------------------
// 引擎目录的固定形状见 engines/_TEMPLATE/。
const GSV_DIR = envDir('GSV_DIR', path.join(ENGINES_DIR, 'gpt-sovits'));
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

// --- GPT-SoVITS 底模：一版一个目录 ------------------------------------------
//
// 盘上的历史布局把四套底模混在两个目录里，而目录名完全不提示这件事：
//
//   gsv-v2final/  v1 的 GPT 底模 + v2 的 GPT 底模 + v2 的 SoVITS 底模
//   v2Pro/        v1 的 SoVITS 底模 + v2Pro 的 + v2ProPlus 的
//
// 也就是说 v1 的两半分处两个目录，且两个目录名都不叫 v1。谁照目录名理解这堆
// 文件都会理解错，此前只能靠一条守卫测试把这份错乱钉住，不让人「顺手理顺」。
//
// 本轮改成一版一目录，目录名即版本名：
//
//   v1/         s1bert25hz-2kh-...ckpt   s2G488k.pth       s2D488k.pth
//   v2/         s1bert25hz-5kh-...ckpt   s2G2333k.pth      s2D2333k.pth
//   v2Pro/                               s2Gv2Pro.pth      s2Dv2Pro.pth
//   v2ProPlus/                           s2Gv2ProPlus.pth  s2Dv2ProPlus.pth
//
// GPT(s1) 侧只有两份底模，v2 / v2Pro / v2ProPlus 三个版本共用 v2 的那一份，
// 所以 s1 只出现在 v1/ 与 v2/ 下，v2Pro/ 与 v2ProPlus/ 里只有 SoVITS 权重。
// 这不是遗漏，是上游就只有两份 —— 见 server.js 的 _baseS1Path()。
//
// 搬家由 tools/scripts/Move-BaseModels.ps1 一次性完成。为了让「只更新代码、
// 还没搬文件」的安装继续工作，每个会移动的权重都按 新位置 → 旧位置 取第一个
// 存在者；两处都没有时返回新位置，使「文件缺失」的报错指向它本该在的地方，
// 而不是指向一个已经废弃的老目录。
const LEGACY_BASE_DIRS = {
  // 仅供上面那条回退用。新代码一律不要引用这两个名字。
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

// 底模的单一事实来源，分三张表：
//
//   BASE_WEIGHTS_CANONICAL  应该在哪 —— 只由布局决定，与盘上有没有文件无关
//   BASE_WEIGHTS_LEGACY     搬家前在哪 —— 没有旧位置的条目为 null
//   BASE_WEIGHTS            现在读哪 —— 上面两者取第一个存在者
//
// 分开是必需的：守卫测试要断言的是布局（不能随某台机器搬没搬家而变），业务代码
// 要的是当下能打开的那个路径。此前两件事挤在一张表里，守卫在没搬家的机器上就会
// 因为回退值而误报——这正是一次真机误报的成因。
//
// 键名 = <角色>_<版本>，s1=GPT，s2G=SoVITS 生成器，s2D=SoVITS 判别器
//（判别器只在微调时用到）。
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

  // v2Pro 的两个文件本来就在 v2Pro/ 下，不搬，因此没有旧位置。
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

// 具体权重子目录。业务代码一律从这里取，不得自行拼接目录名。
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
  // 预处理阶段（2-get-hubert-wav32k.py）要的 SoVITS 生成器，取 v1 的 488k。
  s2G488k: BASE_WEIGHTS.s2G_v1,
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
  // 合成结果复用缓存（内容寻址，文件名就是指纹）。见 lib/cache/segmentCache.js。
  // ⛔ 刻意不在 outputs/ 之下：outputs/ 是用户的产物目录，他随时可以删；
  //    缓存是平台的可再生数据，删掉只是变慢不会变坏 —— 正是 cache/ 的语义。
  segments: path.join(CACHE_DIR, 'segments'),
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
  TRAINING_DIR, INFERENCE_DIR, VENDOR_DIR, ENGINES_DIR, PIPELINE_DIR,
  GSV_DIR, GSV_CODE_DIR, GSV_INFER_DIR, GSV_TRAIN_DIR,
  UVR5_DIR, ASR_DIR, SLICER_DIR,
  // 权重
  MODELS_DIR, TTS_MODELS_DIR, GSV_PRETRAINED_DIR,
  ASR_MODELS_DIR, FASTER_WHISPER_DIR, FUNASR_MODELS_DIR,
  UVR5_WEIGHTS_DIR, VOCODER_DIR, SR_MODELS_DIR, LANG_MODELS_DIR,
  PRETRAINED, BASE_DIRS, BASE_WEIGHTS, LEGACY_BASE_DIRS,
  BASE_WEIGHTS_CANONICAL, BASE_WEIGHTS_LEGACY,
  // 缓存
  CACHE_DIR, CACHE,
  // 启动
  RUNTIME_DIRS, ensureRuntimeDirs,
  // 备忘
  LEGACY_LOCATIONS,
};
