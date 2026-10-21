// 纯函数：.list 解析、customParams 深合并、失败归类。无 IO、无状态。

// 把一个 GPT-SoVITS .list（每行 path|speaker|LANG|text）解析成 segments.json 的
// segments 数组结构。用于「未跑 ASR 但用户自备 .list」时，在 preprocess 前接管。
// 只取 path 的 basename 作为 audio_filename（preprocess 按 basename 对齐音频）。
function parseListToSegments(listContent) {
  const segments = [];
  const lines = String(listContent || '').split('\n');
  let idx = 0;
  for (const raw of lines) {
    const t = raw.replace(/\r$/, '').trim();
    if (!t) continue;
    const parts = t.split('|');
    if (parts.length < 4) continue;
    const p = parts[0].replace(/\\/g, '/');
    const base = p.split('/').pop() || p;
    const lang = (parts[2] || '').trim().toLowerCase();
    const text = parts.slice(3).join('|');
    segments.push({
      index: idx++,
      scene: base.replace(/\.[^.]+$/, ''),
      audio_filename: base,
      audio_path: p,
      text,
      lang: lang || undefined,
      matched: true,
      duration: 0,
      confidence: null,
    });
  }
  return segments;
}

/**
 * 把 customParams 深合并进 base config（覆盖默认）
 * 结构: { training: {...}, steps: { slice: { params: {...} }, ... } }
 */
function mergeCustomParams(base, custom) {
  if (!custom || typeof custom !== 'object') return base;
  const cfg = JSON.parse(JSON.stringify(base));
  if (custom.training) Object.assign(cfg.training, custom.training);
  if (custom.steps) {
    for (const [k, v] of Object.entries(custom.steps)) {
      if (!cfg.steps[k]) cfg.steps[k] = { params: {} };
      if (!cfg.steps[k].params) cfg.steps[k].params = {};
      if (v.params) Object.assign(cfg.steps[k].params, v.params);
    }
  }
  return cfg;
}

// 把失败错误信息归类成人类可读的英文恢复建议（3.B）。
function classifyFailure(message) {
  const m = String(message || '');
  if (/out of memory|outofmemory|cuda error: out of memory|exit code 137|\bSIGKILL\b/i.test(m)) {
    return {
      reasonCode: 'oom',
      reason: 'Out of memory (GPU). Close other GPU-heavy programs (games, browsers, other training) and resume.',
      recoverable: true,
    };
  }
  if (/\b(EBUSY|EPERM|EACCES|ENOTEMPTY)\b|being used by another process|resource busy|permission denied/i.test(m)) {
    return {
      reasonCode: 'file_locked',
      reason: 'A file is locked by another program. Close Explorer windows, audio players, or antivirus holding the dataset, then resume.',
      recoverable: true,
    };
  }
  return { reasonCode: 'error', reason: (m.slice(0, 300) || 'Unknown error'), recoverable: true };
}

module.exports = { parseListToSegments, mergeCustomParams, classifyFailure };
