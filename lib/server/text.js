'use strict';

// ============================================================================
//  文本切分与占位符判定（纯函数，无 IO、无环境依赖）
// ============================================================================
//
// 从 server.js 逐字搬来（P0 拆分任务 2），行为零变化。

// ===========================
//  JAPANESE TEXT SPLITTER
// ===========================
//
// Strategy: length-first with punctuation as preferred break points.
//
// 1. Accumulate sentences (split by sentence-ending punctuation).
// 2. Greedily pack sentences into segments up to softLimit chars.
//    When adding the next sentence would exceed softLimit, close the
//    current segment and start a new one.
// 3. If a single sentence exceeds hardLimit, force-split it at
//    soft-punctuation (、，) boundaries, or by character count as
//    last resort.
//
// This ensures segments are naturally bounded by sentence boundaries
// while staying within the target length.

function splitJapaneseText(text, options = {}) {
  const { softLimit = 30, hardLimit = 60 } = options;
  if (!text || !text.trim()) return [];

  // Normalize
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // Split into sentences by sentence-ending punctuation.
  // Keep the punctuation attached to the sentence it ends.
  const sentenceRegex = /[^。！？…♪!?]*[。！？…♪!?]+/g;
  const sentences = [];
  let match;
  let lastIndex = 0;

  while ((match = sentenceRegex.exec(normalized)) !== null) {
    sentences.push(match[0]);
    lastIndex = sentenceRegex.lastIndex;
  }
  // Capture any remaining text after the last sentence-ending punctuation
  if (lastIndex < normalized.length) {
    const remaining = normalized.slice(lastIndex).trim();
    if (remaining) sentences.push(remaining);
  }

  // If no sentence-ending punctuation found, treat the whole text as one sentence
  if (sentences.length === 0) {
    sentences.push(normalized);
  }

  // Greedily pack sentences into segments up to softLimit
  const segments = [];
  let current = "";

  for (const sentence of sentences) {
    if (!current) {
      // Start a new segment
      if (sentence.length <= softLimit) {
        current = sentence;
      } else {
        // Single sentence exceeds softLimit — force-split it
        segments.push(...forceSplitLong(sentence, softLimit, hardLimit));
      }
    } else {
      // Check if adding this sentence would exceed softLimit
      if ((current + sentence).length <= softLimit) {
        current += sentence;
      } else {
        // Close current segment, start new one
        segments.push(current);
        if (sentence.length <= softLimit) {
          current = sentence;
        } else {
          segments.push(...forceSplitLong(sentence, softLimit, hardLimit));
          current = "";
        }
      }
    }
  }

  // Flush remaining
  if (current) segments.push(current);

  return segments.filter(s => s.trim().length > 0);
}

// Force-split a long sentence at soft-punctuation or by character count
function forceSplitLong(text, softLimit, hardLimit) {
  const chunks = [];

  // Try splitting by soft punctuation (、 ，)
  const parts = text.split(/(?<=[、，])/);

  let current = "";
  for (const part of parts) {
    if (!current) {
      current = part;
    } else if ((current + part).length <= hardLimit) {
      current += part;
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  }
  if (current) chunks.push(current);

  // Final pass: anything still exceeding hardLimit gets character-split
  const result = [];
  for (const chunk of chunks) {
    if (chunk.length <= hardLimit) {
      result.push(chunk);
    } else {
      let remaining = chunk;
      while (remaining.length > 0) {
        const slice = remaining.slice(0, softLimit);
        remaining = remaining.slice(softLimit);
        if (slice.trim()) result.push(slice);
      }
    }
  }

  return result;
}

function isPlaceholder(text) {
  if (!text) return true;
  const s = text.toLowerCase();
  return (
    s.includes("这里填写") || s.includes("todo") || s.includes("placeholder") ||
    s.includes("参照音声") || s.includes("reference") || s.includes("完全一致")
  );
}

module.exports = { splitJapaneseText, forceSplitLong, isPlaceholder };
