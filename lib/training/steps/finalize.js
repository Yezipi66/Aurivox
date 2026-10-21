// 训练收尾步：把训练产物转成标准资产结构，输出到 workDir/_publish/。
// 只做格式转换与拷贝，不删除任何东西；中间产物留在 workDir，由 promote/cleanup 清理。
const path = require('path');
const fs = require('fs');
const assetScanner = require('../../assetScanner');
const { normalizeVersion, versionFromName } = require('../version');
const { slotDir, MODELS_DIR } = require('../../assets/modelLayout');
const { TRAINING_ENGINE_ID, TRAINING_SLOTS } = require('../pipelineIdentity');

const AUDIO_RE = /\.(wav|mp3|flac|m4a|ogg)$/i;

function copyInto(srcFile, dstDir, dstName) {
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(srcFile, path.join(dstDir, dstName || path.basename(srcFile)));
}

async function run(ctx, log) {
  const { workDir, voiceId, inputDir, stepOptions } = ctx;
  const publishDir = path.join(workDir, '_publish');
  const modelLang = ctx.language || 'ja';
  // 模型文件名带语言后缀，meta.json 丢了也能从文件名重建元数据。
  // 音色 id 本身已以语言结尾时不再重复加（Shamare_ja 保持原样）。
  const modelStem = new RegExp(`_${modelLang}$`, 'i').test(voiceId) ? voiceId : `${voiceId}_${modelLang}`;
  // 训练目标版本 → SoVITS 文件名 token（补救线，非权威；meta.base_version 才是第一事实）。
  const sovitsVersionTag = normalizeVersion(
    (ctx.config && ctx.config.training && ctx.config.training.version) || '');
  log(`Finalizing: ${voiceId} (model prefix: ${modelStem}, SoVITS version: ${sovitsVersionTag}, language: ${modelLang})`);

  // 训练产物落到 models/<引擎id>/<权重位>/ 下。落盘与扫盘必须用同一个函数算路径，
  // 各写各的那天就是训练完了界面上看不见的那天。
  // 这里的引擎 id 是管线身份，取自 pipelineIdentity.js，不是平台侧的默认引擎：
  // 平台侧（扫盘/接口/界面）一个引擎名都不写死。别在别处再写这个字面量。
  const gsvSlotDir = (slot) => slotDir(publishDir, TRAINING_ENGINE_ID, slot);

  // 1) raw/ ← 训练实际使用的"raw"。跑过人声提取时，分离后的人声(workDir/denoise)才是
  //  真正的 raw（切片/ASR/训练都以它为准）；提取前的原始混音另行归档到
  //  raw_b4_extraction/。未跑提取时 raw/ 仍取 inputDir（原始输入即 raw，行为不变）。
  const copyRaw = stepOptions?.copyRaw ?? true;
  const denoiseDir = path.join(workDir, 'denoise');
  const extracted = fs.existsSync(denoiseDir)
    && fs.readdirSync(denoiseDir).some(f => AUDIO_RE.test(f));
  const rawSrc = extracted ? denoiseDir : inputDir;
  if (copyRaw && rawSrc && fs.existsSync(rawSrc)) {
    const rawDir = path.join(publishDir, 'raw');
    for (const f of fs.readdirSync(rawSrc)) {
      if (AUDIO_RE.test(f)) {
        const dst = path.join(rawDir, f);
        if (!fs.existsSync(dst)) copyInto(path.join(rawSrc, f), rawDir);
      }
    }
    log(extracted
      ? '  Copied separated vocals to raw/ (post-extraction audio is the training raw)'
      : '  Copied source files to raw/');
  } else {
    log('  Skip copying source files (copyRaw disabled)');
  }

  // 1b) raw_b4_extraction/ ← 提取前的原始混音（仅当本次跑过人声提取时存在）。denoise
  //  步骤已把外部 inputDir 的原始输入快照到 workDir/raw_b4_extraction；此处发布到资产，
  //  使音色目录自包含、便于日后重构/重跑。由 keepRawB4Extraction 开关控制（默认保留）。
  const keepRawB4 = stepOptions?.keepRawB4Extraction ?? true;
  if (extracted && keepRawB4) {
    const b4Snapshot = path.join(workDir, 'raw_b4_extraction');
    const b4HasAudio = fs.existsSync(b4Snapshot)
      && fs.readdirSync(b4Snapshot).some(f => AUDIO_RE.test(f));
    // 回退：denoise 快照缺失（关了快照）时直接取外部 inputDir 原始音频。
    const b4Src = b4HasAudio
      ? b4Snapshot
      : (inputDir && fs.existsSync(inputDir) ? inputDir : null);
    if (b4Src) {
      const b4Dir = path.join(publishDir, 'raw_b4_extraction');
      for (const f of fs.readdirSync(b4Src)) {
        if (AUDIO_RE.test(f)) {
          const dst = path.join(b4Dir, f);
          if (!fs.existsSync(dst)) copyInto(path.join(b4Src, f), b4Dir);
        }
      }
      log('  Archived pre-extraction originals to raw_b4_extraction/');
    }
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
  //  保留来源命名（raw_opt.list / slicer_opt.list），不硬编码成 slicer_opt.list。
  //  asr.js 已把路径列写成资产相对（raw/<f> 或 slicer_opt/<f>），此处直接拷贝。
  //  置信度旁车 <kind>.conf.json 一并发布。
  const asrOutputDir = path.join(workDir, 'asr_output');
  if (fs.existsSync(asrOutputDir)) {
    const lists = fs.readdirSync(asrOutputDir).filter(f => /^(raw_opt|slicer_opt)\.(list|conf\.json)$/i.test(f));
    for (const lf of lists) {
      copyInto(path.join(asrOutputDir, lf), path.join(publishDir, 'asr_opt'), lf);
    }
  }

  // 4) gpt_checkpoints/ ← logs_s1/<voiceId>/ckpt/<voiceId>-e<epoch>.ckpt
  //  只发布 my_save 写出的 "every weights" 推理权重（内含 {weight, config, info}，
  //  可被推理引擎直接加载，文件名形如 <voiceId>-e<epoch>.ckpt）。
  //  同目录下的 Lightning 原生 ckpt（epoch=*-step=*.ckpt / last.ckpt）缺少 config 键，
  //  仅供续训使用，必须跳过：否则推理引擎加载时报 KeyError: 'config'。
  const s1CkptDir = path.join(workDir, 'logs_s1', voiceId, 'ckpt');
  if (fs.existsSync(s1CkptDir)) {
    for (const f of fs.readdirSync(s1CkptDir).filter(f => f.endsWith('.ckpt'))) {
      const m = f.match(/-e(\d+)\.ckpt$/);
      if (!m) continue;  // 跳过 Lightning 原生 ckpt（无 config）
      const outName = `${modelStem}-e${m[1]}.ckpt`; // 语言后缀命名，损坏时可重建元数据
      copyInto(path.join(s1CkptDir, f), gsvSlotDir('gpt'), outName);
    }
  }

  // 5) sovits_models/ ← S2 产物。多版本训练时从 .s2_products.json 逐版本收集，
  //  每个 .pth 带自身版本 token；无清单时回退单目录 logs_s2/<voiceId>。
  const sovitsDir = gsvSlotDir('sovits');
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
  //  finalize 运行在 promote 之前，此时 ctx.publishDir(=assets/<id>) 仍是旧资产。
  //  本次没重新产出的核心资产（切片 / 文本 / 模型 / raw / 用户参考）从旧资产拷进
  //  _publish/，promote 的整目录替换才不会误删它们。首次训练旧资产不存在，全跳过；
  //  局部重建（只补 ASR、只重切片等）时未触及的资产因此得以保住。
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
  for (const sub of ['slicer_opt', 'raw', 'raw_b4_extraction', 'references']) {
    carryForward(sub);
  }

  // models/ 要按每个权重位分别继承，不能整目录一把梭。
  //  粒度必须保持在「一个权重位」这一层：只重训了 S2 时 models/ 因为有了新的
  //  sovits 就算「本次已重生」，老资产里的 S1 权重便不会被继承，
  //  promote 的整目录替换会把它删掉。
  //  逐位继承的附带好处：这个角色别的引擎的模型（这次没碰过）也会被继承回来。
  {
    const oldModelsRoot = assetDir ? path.join(assetDir, MODELS_DIR) : null;
    if (oldModelsRoot && fs.existsSync(oldModelsRoot)) {
      for (const eng of fs.readdirSync(oldModelsRoot, { withFileTypes: true })) {
        if (!eng.isDirectory()) continue;
        for (const slot of fs.readdirSync(path.join(oldModelsRoot, eng.name), { withFileTypes: true })) {
          if (!slot.isDirectory()) continue;
          carryForward(path.join(MODELS_DIR, eng.name, slot.name));
        }
      }
    }
  }

  // asr_opt 特殊处理：raw_opt.list 与 slicer_opt.list 相互独立，按【文件级】合并而非
  // 整目录替换：本次只重生了其中一份时，另一份从旧资产保留（不因整目录 hasFresh
  // 判定被误删）。
  {
    const dstAsr = path.join(publishDir, 'asr_opt');
    const srcAsr = assetDir ? path.join(assetDir, 'asr_opt') : null;
    if (srcAsr && fs.existsSync(srcAsr)) {
      fs.mkdirSync(dstAsr, { recursive: true });
      for (const f of fs.readdirSync(srcAsr)) {
        if (!/\.(list|conf\.json)$/i.test(f)) continue;
        const dstFile = path.join(dstAsr, f);
        if (!fs.existsSync(dstFile)) {
          fs.copyFileSync(path.join(srcAsr, f), dstFile);
          log(`  Inheriting existing asr_opt/${f} (transcript for this source not regenerated; kept)`);
        }
      }
    }
  }

  // 6) 兜底拷贝 segments.json（支持跳过 ASR 的场景）
  //  若 workDir 有 segments.json 而 _publish/ 没有，直接拷过去并改写 audio_path 前缀
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
    } catch {
      // 旧 meta.json 解析不动就整份丢开：merged 保持刚扫出来的那份，不阻断发布。
    }
  }
  // 显示名取建任务时给的值（允许 Unicode）。
  // 没有就给旧 meta 的 display_name，再没有就用 id。
  if (ctx.displayName) merged.display_name = ctx.displayName;
  // 用训练请求中的语言覆盖 scanVoiceDir 的硬编码默认值
  const lang = ctx.language || merged.language || 'ja';
  merged.language = lang;
  merged.prompt_lang = lang;
  merged.text_lang = lang;
  merged.training = { status: 'completed', completed_at: new Date().toISOString() };

  // 精修血缘：记录直接父资产与最初的根资产（链式精修因此保留完整血缘），
  // 以及本次训练用的底模权重、超参与冻结的训练数据来源。
  if (ctx.refinement && typeof ctx.refinement === 'object') {
    const r = ctx.refinement;
    merged.refinement = {
      refinement_type: r.refinement_type || 's2',
      parent_voice_id: r.parent_voice_id || null,
      root_voice_id: r.root_voice_id || r.parent_voice_id || null,
      generation: Number(r.generation) || 1,
      base_s1_checkpoint: r.base_s1_checkpoint || null,
      base_s2_checkpoint: r.base_s2_checkpoint || null,
      additional_epochs: r.additional_epochs != null ? Number(r.additional_epochs) : null,
      additional_s1_epochs: r.additional_s1_epochs != null ? Number(r.additional_s1_epochs) : null,
      additional_s2_epochs: r.additional_s2_epochs != null ? Number(r.additional_s2_epochs) : null,
      learning_rate: r.learning_rate != null ? Number(r.learning_rate) : null,
      source_task_id: ctx.workDir ? path.basename(ctx.workDir) : (r.source_task_id || null),
      created_at: r.created_at || new Date().toISOString(),
      transcript_source: r.transcript_source || null,
    };
    // 带上冻结的训练数据快照（转写血缘互锁）。
    if (r.transcript && typeof r.transcript === 'object') merged.transcript = r.transcript;
  }
  // base_version 是入库第一事实（训练当下即已知）；同时回填 sovits[].version（缺失时）。
  // base_version = 主版本(首个训练版本)；sovits[].version 按【每个文件名 token】逐条回填
  // （多版本时各产物版本不同，不能一刀切写主版本）。
  const primaryVersion = sovitsVersions[0] || sovitsVersionTag;
  if (primaryVersion) merged.base_version = primaryVersion;
  {
    const _m = merged.assets && merged.assets.models && merged.assets.models[TRAINING_ENGINE_ID];
    const _sov = _m && _m[TRAINING_SLOTS.sovits.name];
    if (Array.isArray(_sov)) for (const _it of _sov) {
      if (_it && !_it.version) _it.version = versionFromName(_it.name || _it.path || '') || primaryVersion;
    }
  }
  fs.writeFileSync(path.join(publishDir, 'meta.json'), JSON.stringify(merged, null, 2));

  const countIn = (d) => { try { return fs.readdirSync(d).length; } catch { return 0; } };
  const gptN = countIn(gsvSlotDir(TRAINING_SLOTS.gpt.name));
  const sovN = countIn(sovitsDir);
  const _base = `${MODELS_DIR}/${TRAINING_ENGINE_ID}`;
  log(`Finalize done: ${_base}/${TRAINING_SLOTS.gpt.name}=${gptN}, ${_base}/${TRAINING_SLOTS.sovits.name}=${sovN}, output to _publish/`);
  return { gpt: gptN, sovits: sovN, publishDir };
}

module.exports = { run };
