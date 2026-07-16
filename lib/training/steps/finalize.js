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
const { normalizeVersion, versionFromName } = require('../version');

// Version normalization + filename-token recovery now come from the shared
// lib/training/version.js (CR P1-2.2 dedup).

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
  // 训练目标版本 → SoVITS 文件名 token（补救线，非权威；meta.base_version 才是第一事实）。
  const sovitsVersionTag = normalizeVersion(
    (ctx.config && ctx.config.training && ctx.config.training.version) || '');
  log(`Finalizing: ${voiceId} (model prefix: ${modelStem}, SoVITS version: ${sovitsVersionTag}, language: ${modelLang})`);

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
    log('  Copied source files to raw/');
  } else {
    log('  Skip copying source files (copyRaw disabled)');
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
    log('  Copied slicer_opt/');
  }

  // 3) asr_opt/<raw_opt|slicer_opt>.list ← asr_output/*.list
  //    保留来源命名（raw_opt.list / slicer_opt.list），不再硬编码 slicer_opt.list。
  //    asr.js 已把路径列写成资产相对（raw/<f> 或 slicer_opt/<f>），此处直接拷贝。
  const asrOutputDir = path.join(workDir, 'asr_output');
  if (fs.existsSync(asrOutputDir)) {
    const lists = fs.readdirSync(asrOutputDir).filter(f => /^(raw_opt|slicer_opt)\.list$/i.test(f));
    for (const lf of lists) {
      copyInto(path.join(asrOutputDir, lf), path.join(publishDir, 'asr_opt'), lf);
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

  // 5) sovits_models/ ← S2 产物。task3 多版本(读法 B)时从 .s2_products.json 逐版本收集，
  //    每个 .pth 带自身版本 token；无清单时回退旧单目录 logs_s2/<voiceId>（旧行为完全一致）。
  const sovitsDir = path.join(publishDir, 'sovits_models');
  const mkSovitsName = (f, vtag) => {
    const tag = vtag ? `_${vtag}` : '';
    const m = f.match(/_e(\d+)_s(\d+)\.pth$/i);
    if (m) return `${modelStem}${tag}_e${m[1]}_s${m[2]}.pth`;
    if (f.startsWith(voiceId)) return `${modelStem}${tag}` + f.slice(voiceId.length);
    return f;
  };
  const collectSovits = (dir, vtag) => {
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const item of fs.readdirSync(dir)) {
      const pp = path.join(dir, item);
      if (fs.statSync(pp).isDirectory()) {
        for (const f of fs.readdirSync(pp)) if (f.endsWith('.pth')) { copyInto(path.join(pp, f), sovitsDir, mkSovitsName(f, vtag)); n++; }
      } else if (item.endsWith('.pth')) {
        copyInto(pp, sovitsDir, mkSovitsName(item, vtag)); n++;
      }
    }
    return n;
  };
  let sovitsVersions = [];
  let usedManifest = false;
  const manifestPath = path.join(workDir, '.s2_products.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const mani = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const products = Array.isArray(mani.products) ? mani.products : [];
      for (const pr of products) {
        const vtag = normalizeVersion(pr.version);
        collectSovits(path.join(workDir, pr.dir || ''), vtag);
        if (vtag && !sovitsVersions.includes(vtag)) sovitsVersions.push(vtag);
      }
      if (products.length) { usedManifest = true; log(`  Multi-version SoVITS products: ${sovitsVersions.join(', ')}`); }
    } catch (e) {
      log(`  ⚠ Failed to read .s2_products.json, falling back to single dir: ${e.message}`);
    }
  }
  if (!usedManifest) {
    collectSovits(path.join(workDir, 'logs_s2', voiceId), sovitsVersionTag);
    if (sovitsVersionTag) sovitsVersions = [sovitsVersionTag];
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
      log(`  Inheriting existing ${sub}/ (not regenerated this run; kept from old asset to avoid loss on publish replace)`);
    }
  };
  for (const sub of ['slicer_opt', 'gpt_checkpoints', 'sovits_models', 'raw', 'references']) {
    carryForward(sub);
  }

  // asr_opt 特殊处理：raw_opt.list 与 slicer_opt.list 相互独立，按【文件级】合并而非
  // 整目录替换 —— 本次只重生了其中一份时，另一份从旧资产保留（不因整目录 hasFresh
  // 判定被误删）。
  {
    const dstAsr = path.join(publishDir, 'asr_opt');
    const srcAsr = assetDir ? path.join(assetDir, 'asr_opt') : null;
    if (srcAsr && fs.existsSync(srcAsr)) {
      fs.mkdirSync(dstAsr, { recursive: true });
      for (const f of fs.readdirSync(srcAsr)) {
        if (!/\.list$/i.test(f)) continue;
        const dstFile = path.join(dstAsr, f);
        if (!fs.existsSync(dstFile)) {
          fs.copyFileSync(path.join(srcAsr, f), dstFile);
          log(`  Inheriting existing asr_opt/${f} (transcript for this source not regenerated; kept)`);
        }
      }
    }
  }

  // 6) 兜底拷贝 segments.json（支持跳过 ASR 的场景）
  //    若 workDir 有 segments.json 而 _publish/ 没有，直接拷过去并改写 audio_path 前缀
  const workSegments = path.join(workDir, 'segments.json');
  const publishSegments = path.join(publishDir, 'segments.json');
  if (!fs.existsSync(publishSegments) && fs.existsSync(workSegments)) {
    try {
      const segData = JSON.parse(fs.readFileSync(workSegments, 'utf-8'));
      // 改写 audio_path 前缀为 APP_DIR 相对：assets/{voiceId}/<sourceKind>/<bn>。
      // sourceKind 取自 segData（asr 步骤写入），缺省回退切片来源以兼容旧数据。
      const sk = segData.source_kind === 'raw' ? 'raw' : 'slicer_opt';
      if (segData.segments) {
        for (const seg of segData.segments) {
          if (seg.audio_path && !seg.audio_path.startsWith('assets/')) {
            const bn = path.basename(seg.audio_path);
            seg.audio_path = `assets/${voiceId}/${sk}/${bn}`;
          }
        }
      }
      fs.writeFileSync(publishSegments, JSON.stringify(segData, null, 2));
      log('  Copied segments.json (skip-ASR fallback)');
    } catch (e) {
      log(`  Failed to copy segments.json (ignored): ${e.message}`);
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
  // Option A: persist the human-facing display name (Unicode allowed) supplied
  // at task creation. Falls back to any prior meta display_name, else the id.
  if (ctx.displayName) merged.display_name = ctx.displayName;
  // 用训练请求中的语言覆盖 scanVoiceDir 的硬编码默认值
  const lang = ctx.language || merged.language || 'ja';
  merged.language = lang;
  merged.prompt_lang = lang;
  merged.text_lang = lang;
  merged.training = { status: 'completed', completed_at: new Date().toISOString() };
  // base_version 是入库第一事实（训练当下即已知）；同时回填 sovits[].version（缺失时）。
  // base_version = 主版本(首个训练版本)；sovits[].version 按【每个文件名 token】逐条回填
  // （多版本时各产物版本不同，不能一刀切写主版本）。
  const primaryVersion = sovitsVersions[0] || sovitsVersionTag;
  if (primaryVersion) merged.base_version = primaryVersion;
  {
    const _sov = merged.assets && merged.assets.checkpoints && merged.assets.checkpoints.sovits;
    if (Array.isArray(_sov)) for (const _it of _sov) {
      if (_it && !_it.version) _it.version = versionFromName(_it.name || _it.path || '') || primaryVersion;
    }
  }
  fs.writeFileSync(path.join(publishDir, 'meta.json'), JSON.stringify(merged, null, 2));

  const gptN = fs.existsSync(path.join(publishDir, 'gpt_checkpoints'))
    ? fs.readdirSync(path.join(publishDir, 'gpt_checkpoints')).length : 0;
  const sovN = fs.existsSync(sovitsDir) ? fs.readdirSync(sovitsDir).length : 0;
  log(`Finalize done: gpt_checkpoints=${gptN}, sovits_models=${sovN}, output to _publish/`);
  return { gpt: gptN, sovits: sovN, publishDir };
}

module.exports = { run };
