// 盘上摆的东西 ↔ 名片声明的权重位：对账的唯一一处。判读规则与底模那一侧（lib/assets/baseModels.js）
// 逐字相同，先细后粗：有按权重位分层的目录 ⇒ 只认它；一个位目录都没有 ⇒ 整个引擎目录就是那个位的
// 那一个候选（只在单权重位时成立）。「一份模型齐不齐」用名片写的 models.required 表判。
// 本文件里不许出现任何引擎 id、任何权重位名，有守卫测试盯着。
// 三态纪律：complete === true 是名片点名的东西一个不少；false 是少了，missing 列出少哪些；null 是说
// 不出来（候选是单个文件，或名片没写 required）。

const fs = require('fs');
const path = require('path');

const { listDirEntries, toPosix } = require('./modelLayout');

// 一个候选按名片的 required 齐不齐。只对目录型候选做：文件型候选跳过（complete=null），一份模型
// 是一个文件的引擎，required 列表说的不是它，拿目录的标准去判会得到「全都缺」。
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
  // 说明文字随候选一同传递：界面那一侧不知道名片写了什么，同一句话要在日志和界面两处出现。
  if (!out.complete) out.missing_text = missingText(out);
  return out;
}

// 把「盘上扫到的目录结构」按名片的权重位表归位。scannedSlots 是 scanVoiceModels 里这台引擎那一段：
// { <盘上的目录名>: [候选...] }，纯目录驱动扫出来的，里面的键不保证是权重位名，本函数的一半工作
// 就是判断它们是不是。
// @returns {{bySlot: Object, notes: Array, layout: string}}
// bySlot：{ <权重位名>: [候选...] }，键恰好是名片声明的那些位；位在但空 ⇒ 值是 []，不是缺键。
// notes：诊断。每条 { code, ... }，人话由界面/日志那一侧组织。空数组表示「无需说明」。
// layout：'per_slot' | 'whole_dir' | 'none'：平台是怎么理解盘上那堆东西的。
function resolveEngineSlots({ scannedSlots, engineDir, slots, required } = {}) {
  const declared = (Array.isArray(slots) ? slots : []).filter(s => s && s.name);
  const scanned = (scannedSlots && typeof scannedSlots === 'object') ? scannedSlots : {};
  const notes = [];
  const bySlot = {};
  for (const s of declared) bySlot[s.name] = [];

  // 名片一个位都没写 ⇒ 这台引擎不需要用户选模型。合法，不是出错。
  if (declared.length === 0) return { bySlot, notes, layout: 'none' };

  const declaredNames = new Set(declared.map(s => s.name));
  const present = Object.keys(scanned);
  const layeredHits = present.filter(n => declaredNames.has(n));

  // 第 1 步（细）：有按权重位分层的目录 ⇒ 只认它
  if (layeredHits.length > 0) {
    for (const s of declared) {
      const list = Array.isArray(scanned[s.name]) ? scanned[s.name] : [];
      bySlot[s.name] = list.map(c => annotateCandidate(c, required));
    }
    // 分层已经命中，其余目录名就真的是放错了（而不是某份模型的内部结构）；一个位都没分层时它们
    // 通常是模型自己的子目录，那时不许这么说。
    const strayDirs = present.filter(n => !declaredNames.has(n));
    if (strayDirs.length) {
      notes.push({ code: 'unknown_slot_dir', dirs: strayDirs.sort(), expected: [...declaredNames].sort() });
    }
    const loose = looseFiles(engineDir);
    if (loose.length) notes.push({ code: 'loose_files', files: loose });
    return { bySlot, notes, layout: 'per_slot' };
  }

  // 第 2 步（粗）：一个位目录都没有
  const all = listDirEntries(engineDir);
  if (all.length === 0) {
    // 目录空 / 不存在 ⇒ 无需说明，该角色在此引擎下没有模型。
    return { bySlot, notes, layout: 'none' };
  }

  if (declared.length === 1) {
    // 整个引擎目录就是这个位的那一个候选（与底模那一侧同一条规矩）：单权重位时无歧义。
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

  // 位不止一个、却又没分层 ⇒ 说不出来哪堆是哪个位的：宁可报空，也不许把同一个目录报成两个位的候选。
  notes.push({
    code: 'ambiguous_no_slot_dir',
    expected: [...declaredNames].sort(),
    found: present.sort(),
    entries: all.length,
    path: toPosix(engineDir),
  });
  return { bySlot, notes, layout: 'none' };
}

/** 直接躺在引擎目录下的文件（不含子目录）。 */
function looseFiles(engineDir) {
  return listDirEntries(engineDir).filter(e => !e.is_dir).map(e => e.name);
}

/**
 * 一条 note 的人话。集中在这里，是因为同一句话要在三处出现（服务端日志、接口返回、界面
 * 那一行灰字）。这里不许出现引擎 id、位名常量：名字全部从 note 里来。
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
        + `（${note.expected.join(' / ')}）：平台说不出这些东西该算哪个位的，`
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

/** 「缺了什么」的人话。与 noteText 同一个理由集中在这里。 */
function missingText(cand) {
  if (!cand || cand.complete !== false) return '';
  const m = Array.isArray(cand.missing) ? cand.missing : [];
  return `这一份少了 ${m.length} 样东西：${m.join(' / ')}。`
    + ` 名片点名的东西不齐，引擎装不起来：⚠ 如果你是复制底模改名做的，`
    + `注意**文件名不能改**：平台和引擎都是按名片写的名字找它们的。`;
}

module.exports = {
  resolveEngineSlots,
  annotateCandidate,
  noteText,
  missingText,
};
