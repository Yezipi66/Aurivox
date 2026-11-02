'use strict';

// 从资产的 segments.json 取第一条可用切片，作为参考音频候选。
// 合成主链路（resolveReference）与向导第 5 步的试运行共用这一份：
// 两边各自读盘就会出现两种取法，一边改了另一边不知道。

const fs = require('fs');
const path = require('path');
const PATHS = require('../paths');
const { resolveRefPath } = require('./paths');

const ASSETS_DIR = PATHS.ASSETS_ROOT;

/**
 * 取这台引擎（按资产目录名）的第一条 matched 切片。
 *
 * @param {string} engineId 资产目录名（资产按引擎 id 或位名分目录，与引擎无关）
 * @param {{assetsRoot?: string}} [opts] assetsRoot 仅供单测注入临时目录，
 *        不传时用项目的 ASSETS_ROOT。
 * @returns {{reference_audio: string, reference_text: string}|null}
 *          平台的词。没有可用切片时返回 null，不抛。
 */
function firstRefAudio (engineId, opts = {}) {
  if (!engineId) return null;
  const assetsRoot = opts.assetsRoot || ASSETS_DIR;
  try {
    const segFile = path.join(assetsRoot, String(engineId), 'segments.json');
    if (!fs.existsSync(segFile)) return null;
    const segData = JSON.parse(fs.readFileSync(segFile, 'utf-8'));
    const first = (segData.segments || []).find(
      (s) => s && s.matched && (s.audio || s.audio_path || s.audio_filename));
    if (!first) return null;
    const raw = first.audio || first.audio_path || first.audio_filename;
    if (!raw) return null;
    return { reference_audio: resolveRefPath(raw), reference_text: first.text || '' };
  } catch (e) { console.error('[TTS] Failed to auto-ref:', e.message); }
  return null;
}

module.exports = { firstRefAudio };
