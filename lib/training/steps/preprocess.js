/**
 * Step 4: 预处理 (Preprocessing)
 *
 * 运行完整的预处理流程：
 * 1. 1-get-text.py — BERT + text features (生成 2-name2text-0.txt, 3-bert/)
 * 2. 2-get-hubert-wav32k.py — CNHubert + wav32k (生成 4-cnhubert/, 5-wav32k/)
 * 3. 3-get-semantic.py — semantic tokens (生成 6-name2semantic-0.tsv)
 */

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const { normalizeVersion } = require('../version');

async function run(ctx, log) {
  const { workDir, inputDir, voiceId, config } = ctx;
  const trainCfg = config.training;
  const trainVersion = normalizeVersion(trainCfg.version || trainCfg.model_version || trainCfg.sovits_version);
  const lang = ctx.language || 'ja';
  const isAutoLang = String(lang).toLowerCase() === 'auto';
  // 每行的音素化语言：优先用 ASR 检测/校对后的 segment 语言(auto 挡位关键)，
  // 否则退回全局语言。'auto' 本身不是有效清洗器语言，故需按行落到具体语言。
  const AUTO_LINE_FALLBACK = 'ja';
  const resolveLineLang = (seg) => {
    const sl = String((seg && seg.lang) || '').trim().toLowerCase();
    if (sl && sl !== 'auto') return sl;
    if (!isAutoLang) return lang;
    return AUTO_LINE_FALLBACK;
  };

  log('Preprocessing...');
  log(`GPT epochs: ${trainCfg.gpt_epochs}, SoVITS epochs: ${trainCfg.sovits_epochs}`);

  // 确保 workDir 存在
  fs.mkdirSync(workDir, { recursive: true });

  // 检查 segments.json (先检查 workDir，再检查 inputDir)
  let segmentsPath = path.join(workDir, 'segments.json');
  if (!fs.existsSync(segmentsPath)) {
    segmentsPath = path.join(inputDir, 'segments.json');
  }
  if (!fs.existsSync(segmentsPath)) {
    throw new Error('segments.json not found; run ASR first');
  }
  log(`Using segments.json: ${segmentsPath}`);

  const segData = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
  const segments = segData.segments || [];

  // 生成 2-name2text.txt (pipe-separated, 用于 3-get-semantic.py 的 inp_text)
  const name2textPath = path.join(workDir, '2-name2text.txt');
  if (!fs.existsSync(name2textPath)) {
    const lines = segments.map(seg => {
      const name = path.basename(seg.audio_filename || seg.audio_path || seg.audio || seg.scene || '').replace(/\.[^.]+$/, '');
      const text = seg.text || '';
      return `${name}|${voiceId}|${resolveLineLang(seg)}|${text}`;
    });
    fs.writeFileSync(name2textPath, lines.join('\n') + '\n');
    log(`2-name2text.txt generated (${lines.length} lines)`);
  } else {
    log(`2-name2text.txt already exists`);
  }

  // 检查是否需要运行 Python 预处理脚本
  const needPreprocess = !fs.existsSync(path.join(workDir, '6-name2semantic-0.tsv')) ||
                         !fs.existsSync(path.join(workDir, '4-cnhubert')) ||
                         (fs.existsSync(path.join(workDir, '4-cnhubert')) && fs.readdirSync(path.join(workDir, '4-cnhubert')).length === 0);

  if (needPreprocess) {
    log('Running Python preprocessing scripts...');

    // 清除旧的预处理输出文件，防止 Python 脚本因文件已存在而跳过
    const staleFiles = [
      '2-name2text-0.txt', '2-name2text-1.txt',
      '3-bert', '4-cnhubert', '5-wav32k',
      '6-name2semantic-0.tsv', '6-name2semantic-1.tsv',
    ];
    for (const f of staleFiles) {
      const fp = path.join(workDir, f);
      if (fs.existsSync(fp)) {
        if (fs.statSync(fp).isDirectory()) {
          fs.rmSync(fp, { recursive: true, force: true });
        } else {
          fs.unlinkSync(fp);
        }
        log(`  Removing stale file: ${f}`);
      }
    }

    const gsvCode = path.join(__dirname, '..', 'gsv_code');
    const gsvTools = path.join(__dirname, '..', 'gsv-tools');
    const python = getPythonPath();
    const prepareDir = path.join(gsvCode, 'prepare_datasets');

    const pretrainedS2G = path.join(__dirname, '..', 'gsv-tools', 'pretrained', 'v2Pro', 's2G488k.pth');
    const s2ConfigPath = path.join(gsvCode, 'configs', 's2.json');
    const cnhubertBase = path.join(gsvTools, 'pretrained', 'chinese-hubert-base');
    const bertPretrained = path.join(gsvTools, 'pretrained', 'chinese-roberta-wwm-ext-large');

    // 解析 G2PWModel 目录：单一事实来源 + 兜底。
    // 优先自包含目录 (gsv_code/text/G2PWModel)，回退到外部 GPT_SoVITS。
    // 选取真正含有 g2pW.onnx 权重的目录，避免两处重复维护。
    const g2pwSelfContained = path.join(gsvCode, 'text', 'G2PWModel');
    const g2pwLegacy = path.join(gsvCode, '..', '..', '..', 'GPT_SoVITS', 'text', 'G2PWModel');
    const hasOnnx = (dir) =>
      fs.existsSync(path.join(dir, 'g2pW.onnx')) || fs.existsSync(path.join(dir, 'g2pw.onnx'));
    let g2pwModelDir = g2pwSelfContained;
    if (!hasOnnx(g2pwSelfContained) && hasOnnx(g2pwLegacy)) {
      g2pwModelDir = g2pwLegacy;
      log(`  G2PWModel: no onnx in self-contained dir, falling back to GPT_SoVITS: ${g2pwLegacy}`);
    } else {
      log(`  G2PWModel: ${g2pwModelDir}`);
    }
    if (!hasOnnx(g2pwModelDir)) {
      log(`  ⚠ Warning: g2pW.onnx not found in any candidate dir (${g2pwSelfContained} / ${g2pwLegacy}); G2PW may trigger a network download or fail`);
    }

    // 音频目录：来源感知（切片存在→slicer_opt，否则→raw），与 asr 步骤同一解析器，
    // 保证不切片训练时 inp_wav_dir 正确指向 raw。
    const { resolveAudioSource } = require('./_source');
    const resolved = resolveAudioSource(ctx);
    let wavDir = resolved.srcDir || inputDir;
    log(`  Preprocess audio source: ${resolved.sourceKind || 'inputDir'} → ${wavDir}`);

    const commonEnv = getCleanEnv({
      PYTHONPATH: [path.join(gsvCode, '..')].join(path.delimiter),
      CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0',
      is_half: 'True',
      i_part: '0',
      all_parts: '1',
      exp_name: voiceId,
      opt_dir: workDir,
      inp_text: name2textPath,
      inp_wav_dir: wavDir,
      lang: lang,
      version: trainVersion,
    });

    // Step 1: 1-get-text.py (生成 2-name2text-0.txt + 3-bert/)
    log('  [1/3] Running 1-get-text.py...');
    const r1 = await spawnAsync(python, [path.join(prepareDir, '1-get-text.py')], {
      cwd: gsvCode,
      timeout: 600000,
      env: {
        ...commonEnv,
        bert_pretrained_dir: bertPretrained,
        g2pw_model_dir: g2pwModelDir,
      },
      onChild: (proc) => ctx.setChild(proc),
      onStdout: (s) => log(`[1-get-text] ${s.trimEnd()}`),
      onStderr: (s) => log(`[1-get-text:err] ${s.trimEnd()}`),
    });
    if (r1.status !== 0) {
      throw new Error(`1-get-text.py failed with exit code ${r1.status}: ${r1.stderr.slice(-300)}`);
    }
    if (r1.stderr) log(`  [1-get-text.py stderr] ${r1.stderr.slice(-500)}`);

    // Step 2: 2-get-hubert-wav32k.py (生成 4-cnhubert/ + 5-wav32k/)
    log('  [2/3] Running 2-get-hubert-wav32k.py...');
    const r2 = await spawnAsync(python, [path.join(prepareDir, '2-get-hubert-wav32k.py')], {
      cwd: gsvCode,
      timeout: 600000,
      env: {
        ...commonEnv,
        cnhubert_base_dir: cnhubertBase,
      },
      onChild: (proc) => ctx.setChild(proc),
      onStdout: (s) => log(`[2-hubert] ${s.trimEnd()}`),
      onStderr: (s) => log(`[2-hubert:err] ${s.trimEnd()}`),
    });
    if (r2.status !== 0) {
      throw new Error(`2-get-hubert-wav32k.py failed with exit code ${r2.status}: ${r2.stderr.slice(-300)}`);
    }

    // Step 3: 3-get-semantic.py (生成 6-name2semantic-0.tsv)
    log('  [3/3] Running 3-get-semantic.py...');
    const r3 = await spawnAsync(python, [path.join(prepareDir, '3-get-semantic.py')], {
      cwd: gsvCode,
      timeout: 600000,
      env: {
        ...commonEnv,
        pretrained_s2G: pretrainedS2G,
        s2config_path: s2ConfigPath,
      },
      onChild: (proc) => ctx.setChild(proc),
      onStdout: (s) => log(`[3-semantic] ${s.trimEnd()}`),
      onStderr: (s) => log(`[3-semantic:err] ${s.trimEnd()}`),
    });
    if (r3.status !== 0) {
      throw new Error(`3-get-semantic.py failed with exit code ${r3.status}: ${r3.stderr.slice(-300)}`);
    }

    // Step 4（仅 v2Pro / v2ProPlus）: 2-get-sv.py 生成 7-sv_cn/（说话人向量 SV 特征）。
    // ERes2NetV2 / kaldi 模块位于 lib/inference，需临时加入 PYTHONPATH。
    // 该步失败不致命：数据集在缺 7-sv_cn 时回退零向量，训练仍可继续（仅无 SV 增益）。
    // task3：多版本时只要任一目标版本为 Pro，就生成 SV 特征（版本无关，一次即可）。
    const _preVersions = (Array.isArray(trainCfg.versions) && trainCfg.versions.length)
      ? trainCfg.versions : [trainVersion];
    const _needSv = _preVersions.some((v) => {
      const s = String(v || '').toLowerCase().replace(/[\s_-]/g, '');
      return s === 'v2pro' || s === 'v2proplus';
    });
    if (_needSv) {
      const svCkpt = path.join(gsvTools, 'pretrained', 'sv', 'pretrained_eres2netv2w24s4ep4.ckpt');
      const inferenceDir = path.join(__dirname, '..', '..', 'inference');
      if (!fs.existsSync(svCkpt)) {
        log(`  ⚠ SV pretrained not found (${svCkpt}); skipping 2-get-sv.py; ${trainVersion} will train without SV features.`);
        log(`     Run download_models.py --set sv to download.`);
      } else {
        log('  [4/4] Running 2-get-sv.py (v2Pro SV features)...');
        const r4 = await spawnAsync(python, [path.join(prepareDir, '2-get-sv.py')], {
          cwd: gsvCode,
          timeout: 600000,
          env: {
            ...commonEnv,
            sv_path: svCkpt,
            PYTHONPATH: [commonEnv.PYTHONPATH, inferenceDir].filter(Boolean).join(path.delimiter),
          },
          onChild: (proc) => ctx.setChild(proc),
          onStdout: (s) => log(`[2-get-sv] ${s.trimEnd()}`),
          onStderr: (s) => log(`[2-get-sv:err] ${s.trimEnd()}`),
        });
        if (r4.status !== 0) {
          log(`  ⚠ 2-get-sv.py failed (exit ${r4.status}); falling back to training without SV features: ${(r4.stderr || '').slice(-200)}`);
        }
      }
    }
  } else {
    log('Training data already present; skipping Python preprocessing');
  }

  // 检查训练数据
  const hubertDir = path.join(workDir, '4-cnhubert');
  const wav32kDir = path.join(workDir, '5-wav32k');
  const semanticPath = path.join(workDir, '6-name2semantic-0.tsv');

  const hubertCount = fs.existsSync(hubertDir) ? fs.readdirSync(hubertDir).length : 0;
  const wav32kCount = fs.existsSync(wav32kDir) ? fs.readdirSync(wav32kDir).length : 0;
  const hasSemantic = fs.existsSync(semanticPath);

  log(`Training data: hubert=${hubertCount}, wav32k=${wav32kCount}, semantic=${hasSemantic}`);

  if (!hasSemantic) {
    throw new Error(`Preprocessing did not produce 6-name2semantic-0.tsv (in ${workDir})`);
  }
  if (hubertCount === 0 || wav32kCount === 0) {
    throw new Error(`Preprocessing features are empty: hubert=${hubertCount}, wav32k=${wav32kCount}`);
  }

  // 统计切片
  const slicerDir = path.join(workDir, 'slicer_opt');
  const sliceCount = fs.existsSync(slicerDir)
    ? fs.readdirSync(slicerDir).filter(f => /\.(wav|mp3|flac)$/i.test(f)).length
    : 0;

  // meta.language = 音色推理端默认语言。auto 挡位与底模(BASE_VOICE.language="auto")
  // 对齐：保持 'auto'，推理默认走多语言 auto、靠 auto_base_lang 兜底 CJK。
  // 注意：逐行 .list / 2-name2text 仍用各自检测到的【具体】语言做音素化(见 resolveLineLang)，
  // 只有这个"音色级默认语言"透传 auto，二者互不影响。
  const metaLanguage = lang;

  // 生成 meta.json
  const meta = {
    id: voiceId,
    language: metaLanguage,
    created_at: new Date().toISOString(),
    base_version: trainVersion,
    assets: {
      raw: { dir: 'raw/', file_count: 0, total_duration: 0 },
      slices: { dir: 'slicer_opt/', file_count: sliceCount },
      hubert: { dir: '4-cnhubert/', file_count: hubertCount },
      wav32k: { dir: '5-wav32k/', file_count: wav32kCount },
      checkpoints: { gpt: [], sovits: [] },
    },
    segment_total: segData.total || 0,
    segment_matched: segData.matched || 0,
    training: {
      gpt_epochs: trainCfg.gpt_epochs,
      sovits_epochs: trainCfg.sovits_epochs,
      status: 'pending',
    },
  };

  fs.writeFileSync(path.join(workDir, 'meta.json'), JSON.stringify(meta, null, 2));
  log(`Preprocessing done: ${sliceCount} slices, ${segments.length} segments`);

  // 数据自检：在 S1 训练前检查 phoneme/semantic 行数与交集，提前报人话错误
  const countLines = (p) =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).length : 0;
  const phonemePath = path.join(workDir, '2-name2text-0.txt');
  const semPath     = path.join(workDir, '6-name2semantic-0.tsv');
  const phonemeRows = countLines(phonemePath);
  const semRows     = countLines(semPath);
  // 交集：phoneme 的 key(第1列, \t 分隔) ∩ semantic 的 key(第1列, \t 分隔)
  const keyset = (p) => new Set(
    (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').split('\n') : [])
      .map(l => l.split('\t')[0]).filter(Boolean)
  );
  const inter = [...keyset(semPath)].filter(k => keyset(phonemePath).has(k)).length;
  log(`Data self-check: phoneme rows=${phonemeRows}, semantic rows=${semRows}, trainable intersection=${inter}`);
  if (phonemeRows === 0) {
    throw new Error(
      `Training set is empty: phoneme(2-name2text-0.txt) has 0 rows. Most likely the [language does not match the audio] ` +
      `(current lang=${isAutoLang ? 'auto (per-line detected)' : lang}), so text cannot be converted to phonemes; please verify the language is correct.`);
  }
  if (semRows === 0) {
    throw new Error(`Training set is empty: semantic(6-name2semantic-0.tsv) has 0 rows; hubert features may not match the slice filenames.`);
  }
  if (inter === 0) {
    throw new Error(
      `Training set is empty: phoneme and semantic sample names [do not match at all] (phoneme=${phonemeRows}, semantic=${semRows}); ` +
      `please check that the first column naming in 2-name2text and 6-name2semantic is consistent.`);
  }

  return { metaPath: path.join(workDir, 'meta.json') };
}

module.exports = { run };
