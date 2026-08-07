// Position-aware override helpers shared by the broker's explicit text splitter.
//
// The UI and the Python text preprocessor use absolute Unicode code-point
// positions. The Node broker may split a request into several independent /tts
// calls, so each segment must receive a local copy of the position keys. Without
// this remap, @0 / @1 would be reapplied to the beginning of every segment.

const LANG_POSITION_RE = /^@(\d+)$/;
const PRON_POSITION_RE = /^@(\d+):(.*)$/;

function codePointLength(value) {
  return Array.from(String(value || "")).length;
}

// Find the next occurrence of segmentText in the full text and return its
// absolute Unicode code-point offset. Search starts in UTF-16 code-unit space
// because that is what JavaScript String#indexOf/slice use; the returned offset
// is explicitly converted to code points for Python parity.
function findCodePointOffset(fullText, segmentText, fromCodeUnit = 0) {
  const full = String(fullText || "");
  const segment = String(segmentText || "");
  const at = full.indexOf(segment, Math.max(0, fromCodeUnit));
  if (at < 0) return null;
  return Array.from(full.slice(0, at)).length;
}

function remapLangOverrides(overrides, segmentStart, segmentLength) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
  const out = {};
  const end = segmentStart + segmentLength;
  for (const [key, value] of Object.entries(overrides)) {
    const match = LANG_POSITION_RE.exec(key);
    if (!match) continue;
    const absolute = Number(match[1]);
    if (absolute >= segmentStart && absolute < end) {
      out[`@${absolute - segmentStart}`] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function remapPronOverrides(overrides, segmentStart, segmentLength) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
  const out = {};
  const end = segmentStart + segmentLength;
  for (const [lang, bucket] of Object.entries(overrides)) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
    const nextBucket = {};
    for (const [key, value] of Object.entries(bucket)) {
      const match = PRON_POSITION_RE.exec(key);
      if (!match) {
        // Ordinary word-level/occurrence-level overrides are independent of the
        // broker's text split and can be forwarded unchanged.
        nextBucket[key] = value;
        continue;
      }
      const absolute = Number(match[1]);
      if (absolute >= segmentStart && absolute < end) {
        nextBucket[`@${absolute - segmentStart}:${match[2]}`] = value;
      }
    }
    if (Object.keys(nextBucket).length) out[lang] = nextBucket;
  }
  return Object.keys(out).length ? out : undefined;
}

function remapOverridesForSegment(cfg, fullText, segmentText, fromCodeUnit = 0) {
  const segmentStart = findCodePointOffset(fullText, segmentText, fromCodeUnit);
  if (segmentStart == null) {
    return { cfg: { ...cfg }, nextCodeUnit: fromCodeUnit };
  }
  const segmentLength = codePointLength(segmentText);
  const next = { ...cfg };
  const lang = remapLangOverrides(cfg && cfg.lang_overrides, segmentStart, segmentLength);
  const pron = remapPronOverrides(cfg && cfg.pron_overrides, segmentStart, segmentLength);
  if (lang) next.lang_overrides = lang;
  else delete next.lang_overrides;
  if (pron) next.pron_overrides = pron;
  else if (cfg && cfg.pron_overrides) {
    // Keep ordinary word-level pronunciation overrides, but remove an empty
    // position-only shell so the engine does not receive misleading state.
    const ordinary = {};
    for (const [language, bucket] of Object.entries(cfg.pron_overrides)) {
      if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) continue;
      const b = {};
      for (const [key, value] of Object.entries(bucket)) {
        if (!PRON_POSITION_RE.test(key)) b[key] = value;
      }
      if (Object.keys(b).length) ordinary[language] = b;
    }
    if (Object.keys(ordinary).length) next.pron_overrides = ordinary;
    else delete next.pron_overrides;
  }
  return {
    cfg: next,
    segmentStart,
    segmentLength,
    nextCodeUnit: fullText.indexOf(String(segmentText || ""), Math.max(0, fromCodeUnit)) + String(segmentText || "").length,
  };
}

module.exports = {
  codePointLength,
  findCodePointOffset,
  remapLangOverrides,
  remapPronOverrides,
  remapOverridesForSegment,
};
