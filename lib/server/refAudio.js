'use strict';

// 从资产的 segments.json 取可用切片，作为参考音频候选：firstRefAudio 取第一条，
// listRefAudios 列出全部（向导第 5 步点选用）。合成主链路（resolveReference）与
// 向导第 5 步的试运行共用这一份：两边各自读盘就会出现两种取法，一边改了另一边不知道。

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

/**
 * 列出这台引擎（按资产目录名）的全部 matched 切片，供向导第 5 步点选。
 * 与 firstRefAudio 同一份读盘逻辑：判定条件、路径换算都不许分叉。
 *
 * @param {string} engineId 资产目录名
 * @param {{assetsRoot?: string}} [opts] assetsRoot 仅供单测注入临时目录
 * @returns {Array<{reference_audio: string, reference_text: string,
 *          duration: number|null, name: string}>}
 *          平台的词。没有素材返回空数组，不抛。reference_audio 是换算后的绝对路径；
 *          name 取「场景 #序号」，缺场景时退回文件名。
 */
function listRefAudios (engineId, opts = {}) {
  if (!engineId) return [];
  const assetsRoot = opts.assetsRoot || ASSETS_DIR;
  try {
    const segFile = path.join(assetsRoot, String(engineId), 'segments.json');
    if (!fs.existsSync(segFile)) return [];
    const segData = JSON.parse(fs.readFileSync(segFile, 'utf-8'));
    return (segData.segments || [])
      .filter((s) => s && s.matched && (s.audio || s.audio_path || s.audio_filename))
      .map((s) => {
        const raw = s.audio || s.audio_path || s.audio_filename;
        const filename = String(raw).replace(/\\/g, '/').split('/').pop() || '';
        return {
          reference_audio: resolveRefPath(raw),
          reference_text: s.text || '',
          duration: typeof s.duration === 'number' && s.duration > 0 ? s.duration : null,
          name: (s.scene != null && s.index != null)
            ? `${s.scene} #${s.index}`
            : filename,
        };
      });
  } catch (e) { console.error('[TTS] Failed to list refs:', e.message); }
  return [];
}

module.exports = { firstRefAudio, listRefAudios };
