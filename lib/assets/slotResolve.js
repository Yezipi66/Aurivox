// lib/assets/slotResolve.js
// ---------------------------------------------------------------------------
//  盘上摆的东西 ↔ 名片声明的权重位 —— 对账的唯一一处
// ---------------------------------------------------------------------------
//
// ⭐⭐⭐ 这个文件为什么存在（2026-08-30，Owner 真机撞出来的）
//
//    Owner 把一份模型放成了：
//        assets/<角色>/models/<引擎id>/<那份模型的十几个文件和两个子目录>
//    也就是**没有建权重位那一层**，直接把模型摊在了引擎目录下。
//
//    平台当时的表现是三件事同时发生，而且**一个字都没说**：
//      1. 「这个角色有这台引擎的模型」是**对的** —— 因为那一层只看目录名，
//         于是资产那边的灯亮了；
//      2. 那份模型自己的两个内部子目录（缓存目录、一个子模型目录）被
//         **当成了两个权重位名**；
//      3. 直接躺在引擎目录下的十几个文件被**整个丢掉**，没有日志、没有提示。
//    ⇒ 用户看到的是：认出来了，但是选不出来，而且没有任何一处告诉他为什么。
//
// ⭐⭐ 但真正的毛病不是「用户放错了」，是**平台自己两侧规矩不一样**：
//
//    底模那一侧（lib/assets/baseModels.js）早就写着「先细后粗」两步：
//        1) 有 <目录>/<权重位名>/ 这一层 ⇒ 里面每一项是一个候选
//        2) 没有那一层 ⇒ **整个目录本身就是这个位的那一个候选**（仅单权重位）
//    第 2 步的注释还专门写了它是为谁准备的：「底模是一整套文件、不是单个
//    权重」的引擎。
//
//    而角色资产那一侧**只有第 1 步**。同一个用户、同一台引擎、同一份模型，
//    放进底模目录能用，放进角色目录就不行，且不报错。
//
//    ⇒ 所以这里做的不是「多支持一种摆法」，是**把两侧的规矩对齐**。
//      ⛔ 多支持一种摆法才是单点修复：下一个用户会用第三种摆法。
//
// ⭐⭐ 第二件对齐的事：**「一份模型齐不齐」的那张表，名片早就写了。**
//
//    名片的 models.required 点名了「这台引擎的一份模型算齐需要哪些东西」。
//    平台此前只拿它检查**底模**（lib/engines/checkpoints.js）。可是角色目录
//    里选中的那一份，在开进程那一步是要**整个顶替底模目录**的
//    （lib/engines/launchPlan.js 的 checkpoints 覆盖）—— 顶替进去的那一份
//    按同一张表检查，是从这件事本身推出来的，不是给谁开的特例。
//
//    ⇒ 同一张表，两处使用。**零新字段、零引擎特判**，且这台引擎往后
//      改了 required，两处一起变。
//
// ⛔ 本文件里不许出现任何引擎 id、任何权重位名（gpt / sovits / model …）。
//    判据同全仓：装一台谁都没见过的引擎，这里一个字都不用改。有守卫测试盯着。
//
// ⚠ 三态纪律（全仓统一，别糊成两态）：
//      complete === true   名片点名的东西一个不少
//      complete === false  少了，missing 列出少哪些
//      complete === null   **说不出来** —— 候选是单个文件（那台引擎的一份
//                          模型本来就是一个文件，这张表不适用），或者名片
//                          压根没写 required。⛔ 这不是「齐」也不是「缺」。

const fs = require('fs');
const path = require('path');

const { listDirEntries, toPosix } = require('./modelLayout');

/**
 * 一个候选按名片的 required 齐不齐。
 *
 * ⭐ 只对**目录型**候选做。文件型候选跳过（complete=null）——
 *   一份模型是一个文件的引擎，required 那张表说的不是它。
 *   ⛔ 拿目录的标准去判一个文件，会把所有 GPT-SoVITS 的权重全判成"缺 8 项"。
 */
function annotateCandidate(cand, required) {
  const req = Array.isArray(required) ? required : [];
  if (!cand || !cand.is_dir || req.length === 0) {
    return { ...cand, complete: null, missing: [] };
  }
  const base = cand.path;
  const missing = req.filter((rel) => {
    try {
      fs.statSync(path.resolve(base, String(rel)));
      return false;
    } catch (_) {
      return true;
    }
  });
  const out = { ...cand, complete: missing.length === 0, missing };
  // ⭐ 人话跟着候选一起走。界面那一侧**不拼话** —— 它不知道名片写了什么，
  //   而同一句话要在日志和界面两处出现，拼两遍就是两句话开始分叉的起点。
  if (!out.complete) out.missing_text = missingText(out);
  return out;
}

/**
 * 把「盘上扫到的目录结构」按名片的权重位表归位。
 *
 * @param {object}   o
 * @param {object}   o.scannedSlots  scanVoiceModels 里这台引擎那一段：
 *                                   { <盘上的目录名>: [候选...] }。
 *                                   ⚠ 这份东西是**纯目录驱动**扫出来的，
 *                                     里面的键**不保证**是权重位名 —— 本函数
 *                                     的一半工作就是判断它们是不是。
 * @param {string}   o.engineDir     assets/<角色>/models/<引擎id> 的路径
 * @param {Array}    o.slots         名片声明的权重位（normalizeWeightSlots 的产物）
 * @param {Array}    o.required      名片的 models.required
 *
 * @returns {{bySlot: Object, notes: Array, layout: string}}
 *   bySlot —— { <权重位名>: [候选...] }，键**恰好是名片声明的那些位**，
 *             一个不多一个不少。⚠ 位在但空 ⇒ 值是 []，不是缺键。
 *   notes  —— 诊断。每条 { code, ... }，人话由界面/日志那一侧组织。
 *             ⛔ 空数组表示「没什么要说的」，不表示「一切正常」。
 *   layout —— 'per_slot' | 'whole_dir' | 'none'：平台**是怎么理解**盘上那堆
 *             东西的。⭐ 要报出来：用户放错时最想知道的就是这一句。
 */
function resolveEngineSlots({ scannedSlots, engineDir, slots, required } = {}) {
  const declared = (Array.isArray(slots) ? slots : []).filter(s => s && s.name);
  const scanned = (scannedSlots && typeof scannedSlots === 'object') ? scannedSlots : {};
  const notes = [];
  const bySlot = {};
  for (const s of declared) bySlot[s.name] = [];

  // 名片一个位都没写 ⇒ 这台引擎不需要用户选模型。⛔ 合法，不是出错。
  if (declared.length === 0) return { bySlot, notes, layout: 'none' };

  const declaredNames = new Set(declared.map(s => s.name));
  const present = Object.keys(scanned);
  const layeredHits = present.filter(n => declaredNames.has(n));

  // ── 第 1 步（细）：有按权重位分层的目录 ⇒ 只认它 ────────────────────
  if (layeredHits.length > 0) {
    for (const s of declared) {
      const list = Array.isArray(scanned[s.name]) ? scanned[s.name] : [];
      bySlot[s.name] = list.map(c => annotateCandidate(c, required));
    }
    // ⭐ 分层已经命中，那么**其余目录名就真的是放错了**（而不是某份模型的
    //   内部结构）—— 这时候才有资格说这句话。
    //   ⛔ 反过来（一个位都没分层时）不许说：那时它们多半是模型自己的子目录。
    const strayDirs = present.filter(n => !declaredNames.has(n));
    if (strayDirs.length) {
      notes.push({ code: 'unknown_slot_dir', dirs: strayDirs.sort(), expected: [...declaredNames].sort() });
    }
    const loose = looseFiles(engineDir);
    if (loose.length) notes.push({ code: 'loose_files', files: loose });
    return { bySlot, notes, layout: 'per_slot' };
  }

  // ── 第 2 步（粗）：一个位目录都没有 ─────────────────────────────────
  const all = listDirEntries(engineDir);
  if (all.length === 0) {
    // 目录空 / 不存在 ⇒ 没什么可说的，这个角色在这台引擎下就是没有模型。
    return { bySlot, notes, layout: 'none' };
  }

  if (declared.length === 1) {
    // ⭐⭐ **整个引擎目录就是这个位的那一个候选** —— 与底模那一侧
    //    （baseModels.js 第 2 步）逐字同一条规矩。
    //    单权重位时这件事**无歧义**：那堆东西只可能属于那一个位。
    const name = path.basename(String(engineDir)) || declared[0].name;
    const cand = annotateCandidate({
      name,
      path: toPosix(engineDir),
      is_dir: true,
      size_mb: null,
    }, required);
    bySlot[declared[0].name] = [cand];
    notes.push({
      code: 'whole_dir_as_candidate',
      slot: declared[0].name,
      path: toPosix(engineDir),
      entries: all.length,
    });
    return { bySlot, notes, layout: 'whole_dir' };
  }

  // ⚠ 位不止一个、却又没分层 ⇒ **说不出来哪堆是哪个位的**。
  //   同底模那一侧：宁可报空，也不许把同一个目录报成两个位的候选 —— 那是撒谎。
  notes.push({
    code: 'ambiguous_no_slot_dir',
    expected: [...declaredNames].sort(),
    found: present.sort(),
    entries: all.length,
    path: toPosix(engineDir),
  });
  return { bySlot, notes, layout: 'none' };
}

/** 直接躺在引擎目录下的**文件**（不含子目录）。 */
function looseFiles(engineDir) {
  return listDirEntries(engineDir).filter(e => !e.is_dir).map(e => e.name);
}

/**
 * 一条 note 的人话。
 *
 * ⭐ 集中在这里，是因为同一句话要在**三处**出现（服务端日志、接口返回、
 *   界面那一行灰字）。三处各写一遍的那天，就是它们开始互相矛盾的那天。
 *
 * ⛔ 这里不许出现引擎 id、位名常量 —— 名字全部从 note 里来。
 */
function noteText(note, engineId) {
  if (!note || !note.code) return '';
  const eng = engineId ? `${engineId} ` : '';
  switch (note.code) {
    case 'whole_dir_as_candidate':
      return `${eng}的模型目录下没有建权重位那一层，平台按「整个目录就是一份模型」处理`
        + `（这台引擎只有一个权重位「${note.slot}」，所以这样理解没有歧义）。`
        + ` 想放第二份模型的话，要建成 <这个目录>/${note.slot}/<每份模型一个目录或文件>。`;
    case 'ambiguous_no_slot_dir':
      return `${eng}的模型目录下没有建权重位那一层，而这台引擎有 ${note.expected.length} 个权重位`
        + `（${note.expected.join(' / ')}）—— 平台说不出这些东西该算哪个位的，`
        + `所以一份都没列出来。请按 <这个目录>/<权重位名>/ 分好再来：${note.path}`;
    case 'unknown_slot_dir':
      return `${eng}的模型目录下有 ${note.dirs.length} 个目录不是这台引擎的权重位名`
        + `（${note.dirs.join(' / ')}）；这台引擎的权重位是 ${note.expected.join(' / ')}。`
        + ` 这些目录里的东西没有被列进任何一个下拉。`;
    case 'loose_files':
      return `${eng}的模型目录下直接躺着 ${note.files.length} 个文件`
        + `（${note.files.slice(0, 6).join(' / ')}${note.files.length > 6 ? ' …' : ''}），`
        + `它们不在任何一个权重位目录里，没有被列进下拉。`;
    default:
      return '';
  }
}

/**
 * 「缺了什么」的人话。⭐ 与 noteText 同一个理由集中在这里。
 * @param {object} cand annotateCandidate 的产物
 */
function missingText(cand) {
  if (!cand || cand.complete !== false) return '';
  const m = Array.isArray(cand.missing) ? cand.missing : [];
  return `这一份少了 ${m.length} 样东西：${m.join(' / ')}。`
    + ` 名片点名的东西不齐，引擎装不起来 —— ⚠ 如果你是复制底模改名做的，`
    + `注意**文件名不能改**：平台和引擎都是按名片写的名字找它们的。`;
}

module.exports = {
  resolveEngineSlots,
  annotateCandidate,
  noteText,
  missingText,
};
