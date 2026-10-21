'use strict';

// 文本切分与占位符判定（纯函数，无 IO、无环境依赖）。
// 切分策略：先按句末标点断句，再贪心装箱到 softLimit。单句超长时先在软标点
//（、，）上强切，仍超 hardLimit 才按字数切。

function splitJapaneseText(text, options = {}) {
  const { softLimit = 30, hardLimit = 60 } = options;
  if (!text || !text.trim()) return [];

  // 归一化：换行统一成 \n，首尾去空白。
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // 按句末标点断句，标点跟着它结束的那一句走。
  const sentenceRegex = /[^。！？…♪!?]*[。！？…♪!?]+/g;
  const sentences = [];
  let match;
  let lastIndex = 0;

  while ((match = sentenceRegex.exec(normalized)) !== null) {
    sentences.push(match[0]);
    lastIndex = sentenceRegex.lastIndex;
  }
  // 最后一个句末标点之后的剩余文本也算一句。
  if (lastIndex < normalized.length) {
    const remaining = normalized.slice(lastIndex).trim();
    if (remaining) sentences.push(remaining);
  }

  // 一个句末标点都没找到 ⇒ 整段当一句。
  if (sentences.length === 0) {
    sentences.push(normalized);
  }

  // 贪心装箱到 softLimit。
  const segments = [];
  let current = "";

  for (const sentence of sentences) {
    if (!current) {
      if (sentence.length <= softLimit) {
        current = sentence;
      } else {
        // 单句超 softLimit，强切。
        segments.push(...forceSplitLong(sentence, softLimit, hardLimit));
      }
    } else {
      if ((current + sentence).length <= softLimit) {
        current += sentence;
      } else {
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

  // 收尾。
  if (current) segments.push(current);

  return segments.filter(s => s.trim().length > 0);
}

// 长句在软标点上强切，或按字数切。
function forceSplitLong(text, softLimit, hardLimit) {
  const chunks = [];

  // 先试软标点（、 ，）。
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

  // 最后一遍：仍超 hardLimit 的按字数切。
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

// 判断一段文字是不是占位文本（模板里还没替换的提示语）。
function isPlaceholder(text) {
  if (!text) return true;
  const s = text.toLowerCase();
  return (
    s.includes("这里填写") || s.includes("todo") || s.includes("placeholder") ||
    s.includes("参照音声") || s.includes("reference") || s.includes("完全一致")
  );
}

module.exports = { splitJapaneseText, forceSplitLong, isPlaceholder };
