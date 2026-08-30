// lib/assets/modelLayout.js
// ---------------------------------------------------------------------------
//  一个角色的模型放在磁盘哪里 —— 唯一的一处答案
// ---------------------------------------------------------------------------
//
// ⭐⭐ 这个文件存在的唯一理由：在它出现之前，「模型放在哪」这件事写死在
//    至少 5 个地方（扫盘、训练收尾、资产接口、配方接口、前端一条正则），
//    而且 5 处写的都是 GPT-SoVITS 的答案（gpt_checkpoints/ 与 sovits_models/）。
//    于是第二台引擎的模型在磁盘上没有位置可放，装上了也在界面上一个入口都没有。
//
// ⭐⭐⭐ 模型只有两个来处，而且穷尽（Owner 2026-08-30 定案）：
//
//    ┌──────────┬──────────────────────┬────────────────────────────┐
//    │ 底模     │ 引擎自己的一个全局位置 │ 官方发布 / 社区微调 / 用户手放 │
//    │ 微调模型 │ 角色资产目录下         │ 训练管线「接入」进来的       │
//    └──────────┴──────────────────────┴────────────────────────────┘
//
//    ⛔ 底模那一栏**来源无关**：平台永远不知道那个文件是谁训的，也不需要知道。
//       「模型」这个概念与「我们训练管线的产出物」在这里正式脱钩。
//
//    这个文件只管**下面那一栏**（角色资产目录下的）。底模那一栏在名片的
//    runtime/models 段里，由 lib/engines/checkpoints.js 负责。
//
// ── 磁盘约定 ────────────────────────────────────────────────────────────
//
//    assets/<角色>/models/<引擎id>/<权重位名>/<文件或目录>
//
//    例：assets/LaPlama/models/gpt-sovits/gpt/LaPlama_zh-e8.ckpt
//        assets/LaPlama/models/gpt-sovits/sovits/LaPlama_zh_v2Pro_e8_s96.pth
//        assets/LaPlama/models/indextts2/model/<某个权重目录或文件>
//
// ⭐ 目录名就是引擎 id ⇒ **「哪些角色有这台引擎的模型」＝ 看一眼目录名**，
//    不用问名片、不用猜后缀、不用读文件头。这是整个设计省下来的最大一笔。
//
// ⭐ 权重位名从名片来（`weights[].name`）。平台自己**一个引擎的权重位名都不认识**
//    —— 它只会拼路径和读目录。⛔ 这个文件里不许出现具体引擎 id 或权重位名，
//    有测试守着。
//
// ⚠ 素材（raw / slicer_opt / asr_opt / segments.json）**不在这一层里**，
//    它们仍然直接躺在角色目录下 —— 因为素材是**引擎无关**的：同一份切片
//    喂给哪台引擎都能训。把素材也按引擎分会逼出复制，那是灾难。
//
// ── 老结构 ──────────────────────────────────────────────────────────────
//
//    2026-08-30 之前是 assets/<角色>/gpt_checkpoints/ 与 sovits_models/。
//    ⛔ 平台**不再读这两个目录**，但会在扫盘时把它们**明确报出来**
//       （见 legacyDirsPresent），因为「还没搬」和「这个角色没有模型」
//       在界面上长得一模一样 —— 静默是这个仓库最难查的一种坏法。
//    搬家工具：tools/migrate-asset-models.js（默认空跑）。

const fs = require('fs');
const path = require('path');

/** 角色目录下装模型的那一层。⛔ 唯一定义处。 */
const MODELS_DIR = 'models';

/**
 * 老结构里那两个目录名。
 * ⛔ 只用于「报出来还没搬」，**不用于读取**。搬家工具退役之前不许删这张表。
 */
const LEGACY_MODEL_DIRS = Object.freeze(['gpt_checkpoints', 'sovits_models']);

/** assets/<角色>/models */
function modelsRoot(voiceDir) {
  return path.join(voiceDir, MODELS_DIR);
}

/** assets/<角色>/models/<引擎id> */
function engineModelsDir(voiceDir, engineId) {
  return path.join(modelsRoot(voiceDir), String(engineId));
}

/** assets/<角色>/models/<引擎id>/<权重位名> */
function slotDir(voiceDir, engineId, slotName) {
  return path.join(engineModelsDir(voiceDir, engineId), String(slotName));
}

/**
 * 这个角色底下有哪几台引擎的模型 —— 只看目录名，不问名片。
 *
 * ⭐ 「扫描哪些资产有这台引擎的模型」就是拿它的结果 includes(engineId)。
 * ⚠ fail-open：目录不存在 / 读不动 ⇒ 空数组，不抛。资产库缺一块不该让整页白屏。
 */
function enginesWithModels(voiceDir) {
  const root = modelsRoot(voiceDir);
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents.filter(e => e.isDirectory() && !isNoise(e.name)).map(e => e.name).sort();
}

/**
 * 一个权重位下有哪些候选。
 *
 * ⭐ **一个候选可以是文件，也可以是目录** —— 有的引擎一个模型就是一整个目录
 *    （里面有配置和多个权重文件）。⛔ 只认文件会让整类引擎无法接入。
 *
 * ⚠ 这里**不筛后缀**。后缀是一台引擎的说法；平台列出目录里有什么，
 *   哪个能用是引擎自己的事。唯一的例外是下面那张噪音文件表。
 *
 * @returns {{name:string,path:string,is_dir:boolean,size_mb:number|null}[]}
 */
function listSlotEntries(voiceDir, engineId, slotName) {
  return listDirEntries(slotDir(voiceDir, engineId, slotName));
}

/**
 * 把一个目录里的东西列成候选。
 *
 * ⭐ 抽出来是因为**底模那一侧要用同一条规矩**（lib/assets/baseModels.js）：
 *   不筛后缀、文件和目录都算候选、噪声文件剔掉、按名字排序。
 *   两侧各写一遍的那天，就是同一个文件在两个下拉里长得不一样的那天。
 */
function listDirEntries(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (isNoise(e.name)) continue;
    const full = path.join(dir, e.name);
    const isDir = e.isDirectory();
    let sizeMb = null;
    if (!isDir) {
      try { sizeMb = Math.round(fs.statSync(full).size / (1024 * 1024)); } catch { sizeMb = null; }
    }
    out.push({ name: e.name, path: toPosix(full), is_dir: isDir, size_mb: sizeMb });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * 一个角色底下的全部模型，按「引擎 → 权重位 → 候选」三层摊开。
 *
 * ⭐⭐ **纯目录驱动，一次名片都不问**：有哪几台引擎看目录名，一台引擎有哪几个
 *    权重位也看目录名。⇒ 一台平台从没听说过的引擎，它的模型照样扫得出来。
 *    名片只在**画界面**的时候用（要标签、要顺序、要知道哪个位必填）。
 *
 * ⚠ 空的权重位也保留（值是空数组）：`{}` 和 `{gpt: []}` 是两件事 ——
 *   后者是「位子在那儿，但里面还没有东西」，界面上该画一个空下拉，
 *   而不是当这个位子不存在。
 *
 * @returns {Object<string, Object<string, Array>>}
 */
function scanVoiceModels(voiceDir) {
  const out = {};
  for (const engineId of enginesWithModels(voiceDir)) {
    const engDir = engineModelsDir(voiceDir, engineId);
    let ents;
    try {
      ents = fs.readdirSync(engDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const slots = {};
    for (const e of ents) {
      if (!e.isDirectory() || isNoise(e.name)) continue;
      slots[e.name] = listSlotEntries(voiceDir, engineId, e.name);
    }
    out[engineId] = slots;
  }
  return out;
}

/**
 * 这个角色底下还留着哪些老结构目录（且里面确实有东西）。
 * ⭐ 用来把「还没搬」跟「本来就没有模型」区分开。
 */
function legacyDirsPresent(voiceDir) {
  const out = [];
  for (const d of LEGACY_MODEL_DIRS) {
    const full = path.join(voiceDir, d);
    try {
      const ents = fs.readdirSync(full);
      if (ents.some(n => !isNoise(n))) out.push(d);
    } catch { /* 不存在 = 没这回事 */ }
  }
  return out;
}

/**
 * 名片里那张权重位表 → 规整成 [{name, label}]。
 *
 * ⭐⭐ 名片里**只需要写这一样**（Owner 2026-08-30：「理论上只需要加上我的模型
 *    有几个权重文件就行了」）。位置、后缀、版本一律不用写 —— 位置是平台
 *    约定的，后缀平台不筛，版本平台不需要知道。
 *
 * 三种写法都收（⭐ 收得宽是为了不吓到接引擎的作者）：
 *    2                               → 两个位，名字 model_1 / model_2
 *    ["a", "b"]                      → 两个位，标签同名
 *    [{name:"a", label:"甲模型"}]     → 完整写法
 *
 * ⚠ 名片没写 ⇒ 返回空数组 ＝「这台引擎不需要用户选模型」，**不是出错**。
 *   引擎完全可以只有一个写死的底模。
 */
function normalizeWeightSlots(decl) {
  if (decl == null) return [];
  if (typeof decl === 'number' && Number.isFinite(decl)) {
    const n = Math.max(0, Math.floor(decl));
    return Array.from({ length: n }, (_, i) => ({ name: `model_${i + 1}`, label: `Model ${i + 1}`, param: null, applies_at: 'launch' }));
  }
  if (!Array.isArray(decl)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of decl) {
    let name = null, label = null, param = null, appliesAt = null;
    if (typeof raw === 'string') { name = raw; label = raw; param = null; }
    else if (raw && typeof raw === 'object') {
      // ⭐⭐ 这一份选择**送到哪一步**，只有两种，而且穷尽：
      //   'launch' —— 送进「开进程」那一步（构造参数）。换一份 = 带着它重开一次。
      //   'call'   —— 送进进程活着时的某一次调用。换一份 = 一次调用。
      // ⚠ 不写就按 param 推：写了 param 说明它有名字可以在调用里发出去 ⇒ 'call'；
      //   没写 ⇒ 'launch'。⭐ 这样上游作者一行都不用加，老名片语义原封不动。
      // ⛔ 默认取 'launch' 而不是 'call'：填错的后果不对称 ——
      //   该 launch 当 call ⇒ 发一个没人读的键，用户以为换了而声音没变（最难查）；
      //   该 call 当 launch ⇒ 只是多重开一次进程，慢，但不撒谎。
      appliesAt = raw.applies_at != null ? String(raw.applies_at).trim() : null;
      name = raw.name != null ? String(raw.name) : null;
      label = raw.label != null ? String(raw.label) : name;
      // ⭐ 选中的那一份**用哪个参数名发给引擎**。这个键必须同时出现在名片的
      //   param_keys 里（那张表是词汇表，不在表上的键会被拦下）。
      //
      // ⚠ 不写 = 「这台引擎运行中换不了权重」。此时界面照样把候选列出来
      //   （能不能换 ≠ 有没有），但那个选择不会被发出去 —— 界面必须说明
      //   这一点。⛔ 绝不许悄悄发一个没人读的键：那是撒谎，比不发还糟。
      param = raw.param != null ? String(raw.param).trim() || null : null;
    }
    if (!name) continue;
    name = name.trim();
    if (!name || seen.has(name)) continue;
    // ⛔ 权重位名直接进路径，不许带分隔符往上跳。
    if (/[\\/]/.test(name) || name === '.' || name === '..') continue;
    seen.add(name);
    out.push({
      name,
      label: (label || name).trim() || name,
      param,
      applies_at: appliesAt || (param ? 'call' : 'launch'),
    });
  }
  return out;
}

// ── 内部 ────────────────────────────────────────────────────────────────

/** 系统噪音文件：数进候选会让下拉里冒出一条谁也没放过的东西。 */
/**
 * 从一份 meta.json 里取出某台引擎某个权重位的候选清单。
 *
 * ⭐ 存在的理由：`meta.assets.models[引擎][位]` 这个层级**只许在一个地方拆包**。
 *   接口有四五处要读它，各写各的 `?.` 链条的话，将来这层结构一动就得满仓库找。
 *
 * ⚠ 永远返回数组（没有就是空数组）：⛔ 让调用方去判 undefined 是在制造 bug。
 */
function slotFromMeta(meta, engineId, slotName) {
  const m = meta && meta.assets && meta.assets.models;
  if (!m || typeof m !== 'object') return [];
  const eng = m[engineId];
  if (!eng || typeof eng !== 'object') return [];
  const list = eng[slotName];
  return Array.isArray(list) ? list : [];
}

/** 这份 meta 里有哪几台引擎的模型（且至少有一个候选）。 */
function enginesInMeta(meta) {
  const m = (meta && meta.assets && meta.assets.models) || {};
  return Object.keys(m)
    .filter(e => Object.values(m[e] || {}).some(l => Array.isArray(l) && l.length > 0))
    .sort();
}

function isNoise(name) {
  return name === 'Thumbs.db' || name === 'desktop.ini' || String(name).startsWith('.');
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

module.exports = {
  MODELS_DIR,
  LEGACY_MODEL_DIRS,
  modelsRoot,
  engineModelsDir,
  slotDir,
  enginesWithModels,
  listSlotEntries,
  listDirEntries,
  scanVoiceModels,
  legacyDirsPresent,
  slotFromMeta,
  enginesInMeta,
  normalizeWeightSlots,
  toPosix,
};
