/**
 * 共享的"参考音频来源解析"。训练 pipeline 的 asr / preprocess 步骤，以及 Assets
 * 就地 ASR 恢复，全部通过它决定：本次要对【切片】还是【raw】做处理，以及物理目录。
 *
 * 优先级（去 passthrough 后的统一规则）：
 *   1. 本次新切出的切片      workDir/slicer_opt
 *   2. 资产already有的切片    publishDir/slicer_opt
 *   3. raw 源（不切片模式）   workDir/raw → inputDir → publishDir/raw
 * 切片一旦存在即以切片为准（训练/参考都用切片）；否则回落 raw。
 */
const fs = require('fs');
const path = require('path');

// 与 assetScanner.js / server.js 的音频正则对齐（含 m4a|ogg）。收窄会让「只有 m4a
// 的 raw」对来源解析器隐形 → 该资产被误判为无来源。来源判定要认全部已知格式；
// ASR 引擎对具体格式的兼容性是另一层问题，不在这里丢数据。
const AUDIO_RE = /\.(wav|mp3|flac|m4a|ogg)$/i;

function hasAudio(dir) {
  try { return !!dir && fs.existsSync(dir) && fs.readdirSync(dir).some(f => AUDIO_RE.test(f)); }
  catch { return false; }
}

/**
 * @param {{workDir?:string, inputDir?:string, publishDir?:string}} ctx
 * @returns {{ sourceKind: 'slicer_opt'|'raw'|null, srcDir: string|null }}
 */
function resolveAudioSource(ctx) {
  const { workDir, inputDir, publishDir } = ctx || {};
  const sliceCands = [
    workDir && path.join(workDir, 'slicer_opt'),
    publishDir && path.join(publishDir, 'slicer_opt'),
  ];
  for (const d of sliceCands) {
    if (hasAudio(d)) return { sourceKind: 'slicer_opt', srcDir: d };
  }
  const rawCands = [
    workDir && path.join(workDir, 'raw'),
    inputDir,
    publishDir && path.join(publishDir, 'raw'),
  ];
  for (const d of rawCands) {
    if (hasAudio(d)) return { sourceKind: 'raw', srcDir: d };
  }
  return { sourceKind: null, srcDir: null };
}

module.exports = { resolveAudioSource, hasAudio, AUDIO_RE };
