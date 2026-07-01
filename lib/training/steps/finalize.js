/**
 * Step 6: 收尾整理 (Finalize)
 *
 * 把训练产物从临时工作区转换为标准资产结构，输出到 workDir/_publish/。
 * 只做"格式转换 + 拷贝"，不做任何删除。
 * 中间件留在 workDir，由 promote/cleanup 统一清理。
 */
const path = require('path');
const fs = require('fs');
const assetScanner = require('../../assetScanner');

const AUDIO_RE = /\.(wav|mp3|flac|m4a|ogg)$/i;

function copyInto(srcFile, dstDir, dstName) {
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(srcFile, path.join(dstDir, dstName || path.basename(srcFile)));
}

async function run(ctx, log) {
  const { workDir, voiceId, inputDir, stepOptions } = ctx;
  const publishDir = path.join(workDir, '_publish');
  const modelLang = ctx.language || 'ja';
  // Published model stem embeds the language so metadata can be rebuilt from the
  // filename if meta.json is ever lost/corrupted. If the voice id already ends
  // with the language token, don't double it (e.g. "Shamare_ja" stays as-is).
  const modelStem = new RegExp(`_${modelLang}$`, 'i').test(voiceId) ? voiceId : `${voiceId}_${modelLang}`;
  log(`收尾整理: ${voiceId}（模型命名前缀: ${modelStem}，语言: ${modelLang}）`);

  // 1) raw/ ← 原始输入音频（从 inputDir 拷入）
  const copyRaw = stepOptions?.copyRaw ?? true;
  if (copyRaw && inputDir && fs.existsSync(inputDir)) {
    const rawDir = path.join(publishDir, 'raw');
    for (const f of fs.readdirSync(inputDir)) {
      if (AUDIO_RE.test(f)) {
        const dst = path.join(rawDir, f);
        if (!fs.existsSync(dst)) copyInto(path.join(inputDir, f), rawDir);
      }
    }
    log('  已复制源文件到 raw/');
  } else {
    log('  跳过复制源文件（copyRaw 关闭）');
  }

  // 2) slicer_opt/ ← 由 slice 步骤已产出在 workDir，直接拷入 _publish/
  const slicerSrc = path.join(workDir, 'slicer_opt');
  if (fs.existsSync(slicerSrc)) {
    const slicerDst = path.join(publishDir, 'slicer_opt');
    fs.mkdirSync(slicerDst, { recursive: true });
    for (const f of fs.readdirSync(slicerSrc)) {
      const dst = path.join(slicerDst, f);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(slicerSrc, f), dst);
    }
    log('  已复制 slicer_opt/');
  }

  // 3) asr_opt/slicer_opt.list ← asr_output/*.list
  const asrOutputDir = path.join(workDir, 'asr_output');
  if (fs.existsSync(asrOutputDir)) {
    const lists = fs.readdirSync(asrOutputDir).filter(f => f.endsWith('.list'));
    if (lists.length > 0) {
      copyInto(path.join(asrOutputDir, lists[0]), path.join(publishDir, 'asr_opt'), 'slicer_opt.list');
    }
  }

  // 4) gpt_checkpoints/ ← logs_s1/<voiceId>/ckpt/<voiceId>-e<epoch>.ckpt
  //    只发布 my_save 写出的 "every weights" 推理权重（内含 {weight, config, info}，
  //    可被推理引擎直接加载，文件名形如 <voiceId>-e<epoch>.ckpt）。
  //    同目录下的 Lightning 原生 ckpt（epoch=*-step=*.ckpt / last.ckpt）缺少 config 键，
  //    仅供续训使用，必须跳过——否则推理引擎加载时报 KeyError: 'config'。
  const s1CkptDir = path.join(workDir, 'logs_s1', voiceId, 'ckpt');
  if (fs.existsSync(s1CkptDir)) {
    for (const f of fs.readdirSync(s1CkptDir).filter(f => f.endsWith('.ckpt'))) {
      const m = f.match(/-e(\d+)\.ckpt$/);
      if (!m) continue;  // 跳过 Lightning 原生 ckpt（无 config）
      const outName = `${modelStem}-e${m[1]}.ckpt`; // 语言后缀命名，损坏时可重建元数据
      copyInto(path.join(s1CkptDir, f), path.join(publishDir, 'gpt_checkpoints'), outName);
    }
  }

  // 5) sovits_models/ ← logs_s2/<voiceId>/**.pth（含一层子目录）
  const s2OutputDir = path.join(workDir, 'logs_s2', voiceId);
  const sovitsDir = path.join(publishDir, 'sovits_models');
  // SoVITS 权重文件名形如 <voiceId>_e<epoch>_s<step>.pth。重命名为 <modelStem>_e..._s...
  // 使语言后缀进入文件名（元数据重建来源）。无法解析 epoch/step 的文件按前缀替换兜底。
  const sovitsOutName = (f) => {
    const m = f.match(/_e(\d+)_s(\d+)\.pth$/i);
    if (m) return `${modelStem}_e${m[1]}_s${m[2]}.pth`;
    if (f.startsWith(voiceId)) return modelStem + f.slice(voiceId.length);
    return f;
  };
  if (fs.existsSync(s2OutputDir)) {
    for (const item of fs.readdirSync(s2OutputDir)) {
      const p = path.join(s2OutputDir, item);
      if (fs.statSync(p).isDirectory()) {
        for (const f of fs.readdirSync(p)) {
          if (f.endsWith('.pth')) copyInto(path.join(p, f), sovitsDir, sovitsOutName(f));
        }
      } else if (item.endsWith('.pth')) {
        copyInto(p, sovitsDir, sovitsOutName(item));
      }
    }
  }

  // 5.5) 继承本次未重生的核心资产（全兼容重建）。
  //   finalize 运行在 promote 之前，此时 ctx.publishDir(=assets/<id>) 仍是旧资产。
  //   凡是本次没有重新产出的核心资产（切片 / 文本 / 模型 / raw / 用户参考），从旧
  //   资产拷入 _publish/，这样 promote 的"整目录替换"不会误删它们。
  //   - 首次训练：旧资产不存在 → 全部跳过，无副作用。
  //   - 全量重训：核心资产都已在 _publish 重生（hasFresh）→ 全部跳过。
  //   - 局部重建（如只补 ASR / 只重切片 / 重训但不重切）：自动保住未触及的资产。
  const assetDir = ctx.publishDir; // 旧资产目录 assets/<id>（promote 前仍存在）
  const carryForward = (sub) => {
    const dst = path.join(publishDir, sub);
    const hasFresh = fs.existsSync(dst) && fs.readdirSync(dst).length > 0;
    if (hasFresh) return; // 本次已重生，用新的
    const src = assetDir ? path.join(assetDir, sub) : null;
    if (src && fs.existsSync(src) && fs.readdirSync(src).length > 0) {
      fs.cpSync(src, dst, { recursive: true });
      log(`  继承现有 ${sub}/（本次未重生，从旧资产保留，避免发布替换时丢失）`);
    }
  };
  for (const sub of ['slicer_opt', 'asr_opt', 'gpt_checkpoints', 'sovits_models', 'raw', 'references']) {
    carryForward(sub);
  }

  // 6) 兜底拷贝 segments.json（支持跳过 ASR 的场景）
  //    若 workDir 有 segments.json 而 _publish/ 没有，直接拷过去并改写 audio_path 前缀
  const workSegments = path.join(workDir, 'segments.json');
  const publishSegments = path.join(publishDir, 'segments.json');
  if (!fs.existsSync(publishSegments) && fs.existsSync(workSegments)) {
    try {
      const segData = JSON.parse(fs.readFileSync(workSegments, 'utf-8'));
      // 改写 audio_path 前缀：workDir/slicer_opt/ → assets/{voiceId}/slicer_opt/
      if (segData.segments) {
        for (const seg of segData.segments) {
          if (seg.audio_path && !seg.audio_path.startsWith('assets/')) {
            const bn = path.basename(seg.audio_path);
            seg.audio_path = `assets/${voiceId}/slicer_opt/${bn}`;
          }
        }
      }
      fs.writeFileSync(publishSegments, JSON.stringify(segData, null, 2));
      log('  已拷贝 segments.json（跳过 ASR 兜底）');
    } catch (e) {
      log(`  拷贝 segments.json 失败(忽略): ${e.message}`);
    }
  }

  // 7) 在 _publish/ 上生成合规 meta.json + segments.json
  const fresh = assetScanner.scanVoiceDir(voiceId, publishDir);
  let merged = fresh;
  // 保留旧 meta 中的 display_name / language 等字段（如果存在）
  const oldMetaPath = path.join(publishDir, 'meta.json');
  if (fs.existsSync(oldMetaPath)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldMetaPath, 'utf-8'));
      merged = { ...old, ...fresh, assets: { ...(old.assets || {}), ...(fresh.assets || {}) } };
    } catch {}
  }
  // 用训练请求中的语言覆盖 scanVoiceDir 的硬编码默认值
  const lang = ctx.language || merged.language || 'ja';
  merged.language = lang;
  merged.prompt_lang = lang;
  merged.text_lang = lang;
  merged.training = { status: 'completed', completed_at: new Date().toISOString() };
  fs.writeFileSync(path.join(publishDir, 'meta.json'), JSON.stringify(merged, null, 2));

  const gptN = fs.existsSync(path.join(publishDir, 'gpt_checkpoints'))
    ? fs.readdirSync(path.join(publishDir, 'gpt_checkpoints')).length : 0;
  const sovN = fs.existsSync(sovitsDir) ? fs.readdirSync(sovitsDir).length : 0;
  log(`收尾完成: gpt_checkpoints=${gptN}, sovits_models=${sovN}, 输出到 _publish/`);
  return { gpt: gptN, sovits: sovN, publishDir };
}

module.exports = { run };
