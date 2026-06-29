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

async function run(ctx, log) {
  const { workDir, inputDir, voiceId, config } = ctx;
  const trainCfg = config.training;
  const lang = ctx.language || 'ja';

  log('预处理中...');
  log(`GPT 轮数: ${trainCfg.gpt_epochs}, SoVITS 轮数: ${trainCfg.sovits_epochs}`);

  // 确保 workDir 存在
  fs.mkdirSync(workDir, { recursive: true });

  // 检查 segments.json (先检查 workDir，再检查 inputDir)
  let segmentsPath = path.join(workDir, 'segments.json');
  if (!fs.existsSync(segmentsPath)) {
    segmentsPath = path.join(inputDir, 'segments.json');
  }
  if (!fs.existsSync(segmentsPath)) {
    throw new Error('segments.json 不存在，请先完成语音识别');
  }
  log(`使用 segments.json: ${segmentsPath}`);

  const segData = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
  const segments = segData.segments || [];

  // 生成 2-name2text.txt (pipe-separated, 用于 3-get-semantic.py 的 inp_text)
  const name2textPath = path.join(workDir, '2-name2text.txt');
  if (!fs.existsSync(name2textPath)) {
    const lines = segments.map(seg => {
      const name = path.basename(seg.audio_filename || seg.audio_path || seg.audio || seg.scene || '').replace(/\.[^.]+$/, '');
      const text = seg.text || '';
      return `${name}|${voiceId}|${lang}|${text}`;
    });
    fs.writeFileSync(name2textPath, lines.join('\n') + '\n');
    log(`2-name2text.txt 已生成 (${lines.length} 行)`);
  } else {
    log(`2-name2text.txt 已存在`);
  }

  // 检查是否需要运行 Python 预处理脚本
  const needPreprocess = !fs.existsSync(path.join(workDir, '6-name2semantic-0.tsv')) ||
                         !fs.existsSync(path.join(workDir, '4-cnhubert')) ||
                         (fs.existsSync(path.join(workDir, '4-cnhubert')) && fs.readdirSync(path.join(workDir, '4-cnhubert')).length === 0);

  if (needPreprocess) {
    log('运行 Python 预处理脚本...');

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
        log(`  清除旧文件: ${f}`);
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
      log(`  G2PWModel: 自包含目录无 onnx，回退到 GPT_SoVITS: ${g2pwLegacy}`);
    } else {
      log(`  G2PWModel: ${g2pwModelDir}`);
    }
    if (!hasOnnx(g2pwModelDir)) {
      log(`  ⚠ 警告: 未在任何候选目录找到 g2pW.onnx (${g2pwSelfContained} / ${g2pwLegacy})，G2PW 可能触发联网下载或失败`);
    }

    // 找到切片后的音频目录
    let wavDir = path.join(workDir, 'slicer_opt');
    if (!fs.existsSync(wavDir)) {
      // 如果 slicer_opt 不存在，尝试从 inputDir 查找
      wavDir = path.join(inputDir, 'slicer_opt');
    }
    // 如果还是不存在，用 inputDir 本身
    if (!fs.existsSync(wavDir)) {
      wavDir = inputDir;
    }

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
    });

    // Step 1: 1-get-text.py (生成 2-name2text-0.txt + 3-bert/)
    log('  [1/3] 运行 1-get-text.py...');
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
    log('  [2/3] 运行 2-get-hubert-wav32k.py...');
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
    log('  [3/3] 运行 3-get-semantic.py...');
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
  } else {
    log('训练数据已存在，跳过 Python 预处理');
  }

  // 检查训练数据
  const hubertDir = path.join(workDir, '4-cnhubert');
  const wav32kDir = path.join(workDir, '5-wav32k');
  const semanticPath = path.join(workDir, '6-name2semantic-0.tsv');

  const hubertCount = fs.existsSync(hubertDir) ? fs.readdirSync(hubertDir).length : 0;
  const wav32kCount = fs.existsSync(wav32kDir) ? fs.readdirSync(wav32kDir).length : 0;
  const hasSemantic = fs.existsSync(semanticPath);

  log(`训练数据: hubert=${hubertCount}, wav32k=${wav32kCount}, semantic=${hasSemantic}`);

  if (!hasSemantic) {
    throw new Error(`预处理未生成 6-name2semantic-0.tsv (在 ${workDir})`);
  }
  if (hubertCount === 0 || wav32kCount === 0) {
    throw new Error(`预处理特征为空: hubert=${hubertCount}, wav32k=${wav32kCount}`);
  }

  // 统计切片
  const slicerDir = path.join(workDir, 'slicer_opt');
  const sliceCount = fs.existsSync(slicerDir)
    ? fs.readdirSync(slicerDir).filter(f => /\.(wav|mp3|flac)$/i.test(f)).length
    : 0;

  // 生成 meta.json
  const meta = {
    id: voiceId,
    language: lang,
    created_at: new Date().toISOString(),
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
  log(`预处理完成: ${sliceCount} 切片, ${segments.length} segments`);

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
  log(`数据自检: phoneme行=${phonemeRows}, semantic行=${semRows}, 可训练交集=${inter}`);
  if (phonemeRows === 0) {
    throw new Error(
      `训练集为空：phoneme(2-name2text-0.txt) 0 行。最可能是【语言选择与音频不匹配】` +
      `(当前 lang=${lang})，导致文本无法转音素；请确认语种选对了。`);
  }
  if (semRows === 0) {
    throw new Error(`训练集为空：semantic(6-name2semantic-0.tsv) 0 行，hubert 特征可能未对上切片文件名。`);
  }
  if (inter === 0) {
    throw new Error(
      `训练集为空：phoneme 与 semantic 的样本名【完全对不上】(phoneme=${phonemeRows}, semantic=${semRows})，` +
      `请检查 2-name2text 与 6-name2semantic 的第一列命名是否一致。`);
  }

  return { metaPath: path.join(workDir, 'meta.json') };
}

module.exports = { run };
