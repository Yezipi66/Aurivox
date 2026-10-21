// 读音词典快照：把 data/pron_lexicon/{lang}.json 录成自包含记录，保证重跑可复现。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PRON_LEXICON_DIR } = require('../../paths');
// 词典内联进快照的体积上限。超过就只留 hash + 条目数并标记 truncated。
const PRON_LEXICON_INLINE_MAX = 256 * 1024;

// 快照记内容与 SHA-256：内容供复现，hash 供快速比对。词典是全局可改的，
// 不记快照就分不清两次训练用的是哪一版。目录缺失或文件读不动时只降级成
// 空/部分快照，不抛异常。
function snapshotPronLexicon(language) {
  const snap = {
    capturedAt: new Date().toISOString(),
    dir: PRON_LEXICON_DIR,
    language: language || null,   // 训练语言，仅作记录
    files: {},
  };
  let names = [];
  try { names = fs.readdirSync(PRON_LEXICON_DIR).filter(n => n.endsWith('.json')); }
  catch (_) { return snap; }  // 目录不存在即没有覆盖生效
  for (const name of names) {
    const lang = name.replace(/\.json$/, '');
    const full = path.join(PRON_LEXICON_DIR, name);
    try {
      const raw = fs.readFileSync(full);
      const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
      let entries = null, entryCount = 0, truncated = false;
      try {
        const parsed = JSON.parse(raw.toString('utf-8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entryCount = Object.keys(parsed).length;
          if (raw.length <= PRON_LEXICON_INLINE_MAX) entries = parsed;
          else truncated = true;
        }
      } catch (_) { /* 解析不了，只留字节与 hash */ }
      snap.files[lang] = { path: full, sha256, entryCount, ...(entries ? { entries } : {}), ...(truncated ? { truncated: true } : {}) };
    } catch (_) { /* 文件读不动，跳过 */ }
  }
  return snap;
}

module.exports = { snapshotPronLexicon };
