/**
 * Step 5: 训练 (Training)
 *
 * 调用 s1_train.py + s2_train.py 进行模型训练
 * 使用项目内的 gsv-code/ + 项目 venv 的 Python
 */

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const { normalizeVersion } = require('../version');

const GSV_CODE = path.join(__dirname, '..', 'gsv_code');

const PRETRAINED_DIR = path.join(__dirname, '..', 'gsv-tools', 'pretrained');

// 按候选相对路径依次查找底模，返回首个存在的绝对路径；全部缺失则抛出列出所有搜索位置的清晰错误。
function resolvePretrained(label, candidates) {
  const tried = candidates.map((rel) => path.join(PRETRAINED_DIR, rel));
  const hit = tried.find((p) => fs.existsSync(p));
  if (!hit) {
    throw new Error(
      'Pretrained model not found: ' + label + '. Searched these locations, please verify the file exists:\n  ' + tried.join('\n  ')
    );
  }
  return hit;
}
const PYTHON = getPythonPath();

// 失败时把完整 stdout+stderr 落到 workDir/logs/<step>.log，便于排查
function writeStepLog(workDir, step, stdout, stderr) {
  try {
    const logsDir = path.join(workDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, `${step}.log`);
    const content = [
      `=== STDOUT ===`,
      stdout || '(empty)',
      '',
      `=== STDERR ===`,
      stderr || '(empty)',
    ].join('\n');
    fs.writeFileSync(logPath, content, 'utf-8');
    return logPath;
  } catch (e) {
    return null;
  }
}

// ---- shared helpers (module-level so S1 and S2 can run as independent steps) ----
function resolveBatch(v, fallback) {
  if (v === undefined || v === null || v === 'auto') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : fallback;
}

function buildTrainEnv() {
  return getCleanEnv({
    PYTHONPATH: [path.join(GSV_CODE, '..')].join(path.delimiter),
    CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0',
    PYTHONUNBUFFERED: '1',
    // Multiple bundled deps (torch, numpy MKL, faiss, onnxruntime) each ship their
    // own OpenMP runtime; on Windows the duplicate libiomp5md.dll load aborts the
    // process (native crash) at init/teardown. Tolerate it instead of crashing.
    KMP_DUPLICATE_LIB_OK: 'TRUE',
  });
}

// 检查训练数据 (先检查 workDir，再检查 inputDir，找不到则抛异常)
function makeCheckFile(ctx) {
  return (name) => {
    const wd = path.join(ctx.workDir, name);
    if (fs.existsSync(wd)) return wd;
    const id = path.join(ctx.inputDir, name);
    if (fs.existsSync(id)) return id;
    throw new Error(`File "${name}" not found in workDir or inputDir`);
  };
}

// ===== S1 训练 (GPT) — 独立步骤 =====
async function runS1(ctx, log) {
  const { workDir, voiceId, config } = ctx;
  const trainCfg = config.training;
  const checkFile = makeCheckFile(ctx);

  log(`Starting S1 training (GPT): voice=${voiceId}`);
  log(`GPT epochs: ${trainCfg.gpt_epochs}`);

  // 2-name2text-0.txt 优先，否则 2-name2text.txt
  let name2textPath;
  try {
    name2textPath = checkFile('2-name2text-0.txt');
  } catch {
    name2textPath = checkFile('2-name2text.txt');
  }

  checkFile('segments.json'); // guard: 预处理须已产出 segments

  // ===== S1 训练 =====
  log('\n=== S1 Training (GPT) ===');

  const s1Script = path.join(GSV_CODE, 's1_train.py');
  const s1Config = path.join(GSV_CODE, 'configs', 's1longer.yaml');

  let pretrainedS1 = resolvePretrained('GPT(s1)', [
    path.join('gsv-v2final', 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'),
    's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt',
  ]);

  // Patch #12 — S1 Refinement warm-start: when this run refines S1, continue training
  // from the PARENT asset's published GPT checkpoint instead of the stock base model.
  // The published .ckpt embeds {weight, config, info}; s1_train loads it as pretrained_s1.
  const s1Refine = ctx.refinement && /s1/i.test(String(ctx.refinement.refinement_type || ''))
    ? ctx.refinement : null;
  if (s1Refine && s1Refine.base_s1_checkpoint && fs.existsSync(s1Refine.base_s1_checkpoint)) {
    pretrainedS1 = s1Refine.base_s1_checkpoint;
    log(`[Refine] S1 will continue from parent checkpoint: ${pretrainedS1}`);
  } else if (s1Refine && s1Refine.base_s1_checkpoint) {
    log(`[Refine] ⚠ parent S1 checkpoint not found (${s1Refine.base_s1_checkpoint}); falling back to base pretrained model`);
  }

  // 创建 S1 输出目录
  const s1OutputDir = path.join(workDir, 'logs_s1', voiceId);
  fs.mkdirSync(s1OutputDir, { recursive: true });

// 准备 S1 训练配置
  // GSV only writes a weight checkpoint when (current_epoch+1) % save_every_n_epoch == 0
  // (s1_train.py L50). If the interval exceeds the total epoch count, NO checkpoint is
  // ever saved and the step fails with "未生成 checkpoint" (e.g. 3 epochs, interval 4).
  // Clamp the interval to the epoch count so the final epoch always produces a ckpt.
  const gptEpochs = Math.max(1, Number(trainCfg.gpt_epochs) || 20);
  // Patch #10: S1 uses its own save interval (default 4 → epoch 8 lands on a save).
  // Legacy recipes that only carry the shared `save_every_n_epoch` still work.
  const s1SaveEveryRaw = trainCfg.s1_save_every_n_epoch ?? trainCfg.save_every_n_epoch ?? 4;
  const s1SaveEvery = Math.min(Math.max(1, Number(s1SaveEveryRaw) || 4), gptEpochs);
  const s1ConfigData = {
    train: {
      seed: trainCfg.seed ?? 1234,
      epochs: gptEpochs,
      batch_size: resolveBatch(trainCfg.batch_size, 8),
      save_every_n_epoch: s1SaveEvery,
      precision: trainCfg.precision || '16-mixed',
      gradient_clip: trainCfg.gradient_clip ?? 1.0,
      if_save_latest: true,
      if_save_every_weights: true,
      half_weights_save_dir: path.join(s1OutputDir, 'ckpt'),
      exp_name: voiceId,
      inference: { top_k: 5 },
    },
    optimizer: {
      lr: trainCfg.lr ?? 0.01,
      lr_init: trainCfg.lr_init ?? 0.00001,
      lr_end: trainCfg.lr_end ?? 0.0001,
      warmup_steps: trainCfg.warmup_steps ?? 2000,
      decay_steps: trainCfg.decay_steps ?? 40000,
    },
    data: {
      max_eval_sample: trainCfg.max_eval_sample ?? 8,
      max_sec: trainCfg.max_sec ?? 54,
      num_workers: trainCfg.num_workers ?? 4,
      pad_val: 1024,
    },
    model: {
      vocab_size: 1025, phoneme_vocab_size: 732, embedding_dim: 512,
      hidden_dim: 512, head: 16, linear_units: 2048, n_layer: 24,
      dropout: 0, EOS: 1024, random_bert: 0,
    },
    output_dir: s1OutputDir,
    pretrained_s1: pretrainedS1,
    train_semantic_path: checkFile('6-name2semantic-0.tsv'),
    train_phoneme_path: name2textPath,
  };

  const s1TmpConfig = path.join(workDir, 's1_train_config.yaml');
  const yaml = require('js-yaml');
  fs.writeFileSync(s1TmpConfig, yaml.dump(s1ConfigData));

  log(`S1 output: ${s1OutputDir}`);
  const s1Cmd = [PYTHON, s1Script, '-c', s1TmpConfig];
  log(`Exec: ${s1Cmd.join(' ')}`);

  const trainEnv = buildTrainEnv();

  const s1Result = await spawnAsync(s1Cmd[0], s1Cmd.slice(1), {
    timeout: 86400000,
    env: trainEnv,
    onChild: (proc) => ctx.setChild(proc),
    onStdout: (s) => log(`[S1] ${s.trimEnd()}`),
    onStderr: (s) => log(`[S1:err] ${s.trimEnd()}`),
  });
  if (s1Result.status !== 0) {
    // A native crash during interpreter / DataLoader-worker teardown (notably the
    // Windows access violation 0xC0000005 = exit code 3221225477) can fire AFTER
    // every epoch finished and ModelCheckpoint already wrote the weights. In that
    // case the model is complete on disk, so salvage it rather than discard a run
    // that actually succeeded. Only salvage when the LAST SCHEDULED save weight
    // exists — i.e. the last epoch this run would ever checkpoint (a multiple of
    // save_every_n_epoch), which is the exact weight a fully-successful run would
    // also deliver. If the crash happened earlier, this file is absent -> fail.
    const lastSaveEpoch = Math.floor(gptEpochs / s1SaveEvery) * s1SaveEvery;
    const finalCkpt = path.join(s1OutputDir, 'ckpt', `${voiceId}-e${lastSaveEpoch}.ckpt`);
    if (lastSaveEpoch >= 1 && fs.existsSync(finalCkpt)) {
      log(`[S1] Process exited with code ${s1Result.status}, but the last scheduled weight already exists (${finalCkpt}). Treating S1 as complete (post-save teardown crash).`);
      writeStepLog(workDir, 's1', s1Result.stdout, s1Result.stderr);
    } else {
      const logPath = writeStepLog(workDir, 's1', s1Result.stdout, s1Result.stderr);
      const suffix = logPath ? ` (see ${logPath})` : '';
      throw new Error(`S1 training failed (exit code ${s1Result.status}): ${s1Result.stderr.slice(-300)}${suffix}`);
    }
  }
  if (s1Result.stdout) log(`S1 stdout: ${s1Result.stdout.slice(-500)}`);
  if (s1Result.stderr) log(`S1 stderr: ${s1Result.stderr.slice(-500)}`);

  // 查找 S1 checkpoint
  const s1CkptDir = path.join(s1OutputDir, 'ckpt');
  const s1Ckpts = fs.existsSync(s1CkptDir) ? fs.readdirSync(s1CkptDir).filter(f => f.endsWith('.ckpt')) : [];
  if (s1Ckpts.length === 0) throw new Error('S1 training produced no checkpoint');
  const latestS1 = path.join(s1CkptDir, s1Ckpts.slice().sort((a, b) => {
    const ea = parseInt(a.match(/-e(\d+)/)?.[1] || '0', 10);
    const eb = parseInt(b.match(/-e(\d+)/)?.[1] || '0', 10);
    return ea - eb;
  }).pop());
  log(`S1 done: ${latestS1}`);
  return { s1OutputDir, s1Ckpts, latestS1 };
}

// ===== S2 训练 (SoVITS) — 独立步骤 =====
async function runS2(ctx, log) {
  const { workDir, voiceId, config } = ctx;
  const trainCfg = config.training;
  const checkFile = makeCheckFile(ctx);
  const trainEnv = buildTrainEnv();

  log(`Starting S2 training (SoVITS): voice=${voiceId}`);
  log(`SoVITS epochs: ${trainCfg.sovits_epochs}`);
  checkFile('segments.json'); // guard: 预处理须已产出 segments

  // ===== S2 训练 =====
  log('\n=== S2 Training (SoVITS) ===');

  const s2ConfigPath = path.join(GSV_CODE, 'configs', 's2.json');

  // 检查 S2 训练数据 (先检查 workDir，再检查 inputDir)
  const hubertDir = checkFile('4-cnhubert');
  const wav32kDir = checkFile('5-wav32k');
  if (!fs.existsSync(hubertDir) || fs.readdirSync(hubertDir).length === 0) {
    throw new Error('4-cnhubert/ is empty; run preprocessing first');
  }
  if (!fs.existsSync(wav32kDir) || fs.readdirSync(wav32kDir).length === 0) {
    throw new Error('5-wav32k/ is empty; run preprocessing first');
  }

  // ===== task3 MULTI_VERSION_S2：读法 B —— 一次训练可产出多个 SoVITS 版本 =====
  // versions[] 优先；缺省回退单 version；再缺省 v2。单版本时行为/目录与旧版完全一致。
  let trainVersions = (Array.isArray(trainCfg.versions) && trainCfg.versions.length)
    ? trainCfg.versions.map(normalizeVersion)
    : [normalizeVersion(trainCfg.version || trainCfg.model_version || trainCfg.sovits_version)];
  trainVersions = trainVersions.filter((v, i) => trainVersions.indexOf(v) === i); // 去重保序
  log(`S2 target versions: ${trainVersions.join(', ')}`);

  // 底模按版本选择：v2 优先真正的 v2 底模 s2G2333k（回退 s2G488k 走 shape-safe）；
  // v2Pro / v2ProPlus 用各自的 Pro 底模。
  const _S2G_CANDS = {
    v2: ['gsv-v2final/s2G2333k.pth', 'gsv-v2final-pretrained/s2G2333k.pth', 's2G2333k.pth',
         'v2Pro/s2G488k.pth', 's2G488k.pth', 'gsv-v2final/s2G488k.pth'],
    v2Pro: ['v2Pro/s2Gv2Pro.pth'],
    v2ProPlus: ['v2Pro/s2Gv2ProPlus.pth'],
  };
  const _S2D_CANDS = {
    v2: ['gsv-v2final/s2D2333k.pth', 'gsv-v2final-pretrained/s2D2333k.pth', 's2D2333k.pth',
         'v2Pro/s2D488k.pth', 's2D488k.pth', 'gsv-v2final/s2D488k.pth'],
    v2Pro: ['v2Pro/s2Dv2Pro.pth'],
    v2ProPlus: ['v2Pro/s2Dv2ProPlus.pth'],
  };

  // 版本无关的训练数据一次性复制到 workDir（各版本共用同一份特征）。
  const copyData = (name) => {
    const srcPath = path.join(ctx.inputDir, name);
    const dstPath = path.join(workDir, name);
    if (fs.existsSync(dstPath)) return;
    if (!fs.existsSync(srcPath)) return;
    if (fs.statSync(srcPath).isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      for (const f of fs.readdirSync(srcPath)) {
        fs.copyFileSync(path.join(srcPath, f), path.join(dstPath, f));
      }
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
    log(`  Copy ${name} from inputDir`);
  };
  copyData('2-name2text.txt');
  copyData('2-name2text-0.txt');
  copyData('4-cnhubert');
  copyData('5-wav32k');
  copyData('6-name2semantic-0.tsv');
  copyData('7-sv_cn');

  const allS2Models = [];
  const s2Products = [];
  let firstOutputDir = null;

  // Patch #12 — S2 Acoustic Refinement: continue training from a PARENT asset's
  // published SoVITS generator instead of the stock base model. The parent .pth is
  // a generator checkpoint (savee() output), shape-compatible with s2_train's
  // pretrained_s2G loader for the same version. The discriminator stays the base
  // model (no published s2D exists); this is standard warm-start refinement. When
  // refining, the pipeline runs only the selected version to keep shapes matched.
  const refine = ctx.refinement && ctx.refinement.base_s2_checkpoint
    && /s2/i.test(String(ctx.refinement.refinement_type || 's2')) ? ctx.refinement : null;
  if (refine && fs.existsSync(refine.base_s2_checkpoint)) {
    log(`[Refine] S2 will continue from parent checkpoint: ${refine.base_s2_checkpoint}`);
  } else if (refine) {
    log(`[Refine] ⚠ parent S2 checkpoint not found (${refine.base_s2_checkpoint}); falling back to base pretrained model`);
  }

  for (const trainVersion of trainVersions) {
    const useParentS2G = refine && fs.existsSync(refine.base_s2_checkpoint);
    const pretrainedS2G = useParentS2G
      ? refine.base_s2_checkpoint
      : resolvePretrained('SoVITS 生成器(s2G/' + trainVersion + ')', _S2G_CANDS[trainVersion]);
    const pretrainedS2D = resolvePretrained('SoVITS 判别器(s2D/' + trainVersion + ')', _S2D_CANDS[trainVersion]);

    // 单版本沿用旧目录 logs_s2/<voiceId>（与旧行为、旧 finalize 完全一致）；
    // 多版本用 logs_s2_<version>/<voiceId> 隔离各版本产物。
    const s2DirName = trainVersions.length === 1 ? 'logs_s2' : ('logs_s2_' + trainVersion);
    const s2OutputDir = path.join(workDir, s2DirName, voiceId);
    const s2ExpDir = path.join(s2OutputDir, '44k');
    fs.mkdirSync(s2ExpDir, { recursive: true });
    if (!firstOutputDir) firstOutputDir = s2OutputDir;

    // 复制训练数据到该版本的 S2 实验目录
    const files = { '2-name2text-0.txt': '2-name2text.txt', '4-cnhubert': '4-cnhubert', '5-wav32k': '5-wav32k' };
    for (const [src, dst] of Object.entries(files)) {
      const dstPath = path.join(s2ExpDir, dst);
      if (fs.existsSync(dstPath)) continue;
      if (fs.statSync(path.join(workDir, src)).isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        for (const f of fs.readdirSync(path.join(workDir, src))) {
          fs.copyFileSync(path.join(workDir, src, f), path.join(dstPath, f));
        }
      } else {
        fs.copyFileSync(path.join(workDir, src), dstPath);
      }
    }

    // v2Pro / v2ProPlus: 复制 SV 特征目录到实验目录（缺失则数据集回退零向量）
    {
      const svSrc = path.join(workDir, '7-sv_cn');
      const svDst = path.join(s2ExpDir, '7-sv_cn');
      if (fs.existsSync(svSrc) && !fs.existsSync(svDst)) {
        fs.mkdirSync(svDst, { recursive: true });
        for (const f of fs.readdirSync(svSrc)) {
          fs.copyFileSync(path.join(svSrc, f), path.join(svDst, f));
        }
        log('  Copy 7-sv_cn to S2 experiment dir');
      }
    }

    // 准备 S2 配置 — 每版本独立临时文件，避免并发/覆盖冲突
    const s2Config = JSON.parse(fs.readFileSync(s2ConfigPath, 'utf-8'));
    s2Config.s2_ckpt_dir = s2OutputDir;
    // Same clamp as S1: s2_train.py saves weights only when epoch % save_every_epoch == 0,
    // so an interval larger than the epoch count yields no .pth and the step fails.
    const sovitsEpochs = Math.max(1, Number(trainCfg.sovits_epochs) || 10);
    s2Config.train.epochs = sovitsEpochs;
    // Patch #10: S2 uses its own save interval (default 5 → epoch 25 lands on a save).
    const s2SaveEveryRaw = trainCfg.s2_save_every_n_epoch ?? trainCfg.save_every_n_epoch ?? 4;
    s2Config.train.batch_size = resolveBatch(trainCfg.batch_size, 4);

    // Learning rate
    if (trainCfg.learning_rate !== undefined &&
        trainCfg.learning_rate !== null &&
        trainCfg.learning_rate !== 'default') {
      const lr = Number(trainCfg.learning_rate);
      if (Number.isFinite(lr) && lr > 0 && lr <= 1) {
        s2Config.train.learning_rate = lr;
        log(`[${trainVersion}] S2 learning rate override: ${lr}`);
      }
    }

    s2Config.train.fp16_run = trainCfg.fp16_run !== false;
    s2Config.train.save_every_epoch = Math.min(Math.max(1, Number(s2SaveEveryRaw) || 5), sovitsEpochs);
    s2Config.train.if_save_latest = 1;
    s2Config.train.exp_name = voiceId;
    // S2 advanced params
    if (trainCfg.log_interval) s2Config.train.log_interval = Number(trainCfg.log_interval);
    if (trainCfg.eval_interval) s2Config.train.eval_interval = Number(trainCfg.eval_interval);
    if (trainCfg.lr_decay) s2Config.train.lr_decay = Number(trainCfg.lr_decay);
    if (trainCfg.segment_size) s2Config.train.segment_size = Number(trainCfg.segment_size);
    if (trainCfg.c_mel) s2Config.train.c_mel = Number(trainCfg.c_mel);
    if (trainCfg.c_kl) s2Config.train.c_kl = Number(trainCfg.c_kl);
    if (trainCfg.text_low_lr_rate) s2Config.train.text_low_lr_rate = Number(trainCfg.text_low_lr_rate);
    if (trainCfg.grad_ckpt) s2Config.train.grad_ckpt = true;
    s2Config.data.n_speakers = 300;
    s2Config.data.cleaned_text = true;
    s2Config.data.exp_dir = s2ExpDir;
    s2Config.model.version = trainVersion;
    s2Config.name = voiceId;
    s2Config.save_weight_dir = s2OutputDir;

    // Ensure save directory exists before training starts
    fs.mkdirSync(s2OutputDir, { recursive: true });

    // 权威来源：运行时解析的底模路径，覆盖模板中可能过期的绝对路径
    s2Config.train.pretrained_s2G = pretrainedS2G;
    s2Config.train.pretrained_s2D = pretrainedS2D;
    log(`[${trainVersion}] S2 pretrained: G=${pretrainedS2G}  D=${pretrainedS2D}`);

    const s2TmpConfig = path.join(workDir, `s2_train_config_${trainVersion}.json`);
    fs.writeFileSync(s2TmpConfig, JSON.stringify(s2Config, null, 2));

    log(`[${trainVersion}] S2 output: ${s2OutputDir}`);
    log(`[${trainVersion}] S2 exp_dir: ${s2Config.data.exp_dir}`);
    log(`[${trainVersion}] S2 config written to: ${s2TmpConfig}`);

    const s2Cmd = [PYTHON, 's2_train.py', '-c', s2TmpConfig];
    log(`[${trainVersion}] Exec: ${s2Cmd.join(' ')} (cwd=${GSV_CODE})`);

    const s2Result = await spawnAsync(s2Cmd[0], s2Cmd.slice(1), {
      cwd: GSV_CODE,
      timeout: 86400000,
      env: trainEnv,
      onChild: (proc) => ctx.setChild(proc),
      onStdout: (s) => log(`[S2:${trainVersion}] ${s.trimEnd()}`),
      onStderr: (s) => log(`[S2:${trainVersion}:err] ${s.trimEnd()}`),
    });
    if (s2Result.status !== 0) {
      // Same salvage logic as S1: a native teardown crash (e.g. Windows access
      // violation 0xC0000005 = exit 3221225477) can fire AFTER the last epoch was
      // trained and savee() already wrote the usable weight into save_weight_dir.
      // savee names files "<name>_e<epoch>_s<step>.pth" and only saves on epochs
      // that are multiples of save_every_epoch, so check for the last scheduled
      // save epoch. If present, the model is complete on disk -> salvage.
      const s2SaveEvery = s2Config.train.save_every_epoch;
      const s2LastSaveEpoch = Math.floor(sovitsEpochs / s2SaveEvery) * s2SaveEvery;
      const salvaged = s2LastSaveEpoch >= 1 && fs.existsSync(s2OutputDir) &&
        fs.readdirSync(s2OutputDir).some((f) =>
          new RegExp(`^${voiceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_e${s2LastSaveEpoch}_s\\d+\\.pth$`).test(f));
      if (salvaged) {
        log(`[S2:${trainVersion}] Process exited with code ${s2Result.status}, but the last scheduled weight (epoch ${s2LastSaveEpoch}) already exists in ${s2OutputDir}. Treating S2 as complete (post-save teardown crash).`);
        writeStepLog(workDir, 's2_' + trainVersion, s2Result.stdout, s2Result.stderr);
      } else {
        const logPath = writeStepLog(workDir, 's2_' + trainVersion, s2Result.stdout, s2Result.stderr);
        const suffix = logPath ? ` (see ${logPath})` : '';
        throw new Error(`S2 training failed [${trainVersion}] (exit code ${s2Result.status}): ${s2Result.stderr.slice(-300)}${suffix}`);
      }
    }
    if (s2Result.stdout) log(`[${trainVersion}] S2 stdout: ${s2Result.stdout.slice(-500)}`);
    if (s2Result.stderr) log(`[${trainVersion}] S2 stderr: ${s2Result.stderr.slice(-500)}`);

    // 查找该版本的 S2 模型
    const s2Models = [];
    for (const item of fs.readdirSync(s2OutputDir)) {
      const pp = path.join(s2OutputDir, item);
      if (fs.statSync(pp).isDirectory()) {
        s2Models.push(...fs.readdirSync(pp).filter((f) => f.endsWith('.pth')));
      } else if (item.endsWith('.pth')) {
        s2Models.push(item);
      }
    }
    allS2Models.push(...s2Models);
    s2Products.push({ version: trainVersion, dir: path.relative(workDir, s2OutputDir).split(path.sep).join('/') });
    log(`[${trainVersion}] S2 done, models: ${s2Models.length}`);
  }

  // 写多产物清单，供 finalize 按版本各自命名 / 记录（版本第一事实来源）。
  try {
    fs.writeFileSync(
      path.join(workDir, '.s2_products.json'),
      JSON.stringify({ products: s2Products, primary: trainVersions[0] }, null, 2)
    );
  } catch (e) {
    log(`  ⚠ Failed to write .s2_products.json (ignored): ${e.message}`);
  }

  log(`S2 all done, total models: ${allS2Models.length} (versions: ${trainVersions.join(', ')})`);
  return { s2OutputDir: firstOutputDir, s2Models: allS2Models, s2Products };
}

// 兼容旧的单一 "train" 步骤：按 stepOptions 分别 gate S1/S2。
async function run(ctx, log) {
  const opts = (ctx && ctx.stepOptions) || {};
  const doS1 = opts.train_s1 ?? opts.train ?? true;
  const doS2 = opts.train_s2 ?? opts.train ?? true;

  const result = {};
  if (doS1) {
    Object.assign(result, await runS1(ctx, log));
  } else {
    log('Skip S1 training (stepOptions)');
  }
  if (doS2) {
    Object.assign(result, await runS2(ctx, log));
  } else {
    log('Skip S2 training (stepOptions)');
  }
  return result;
}

module.exports = { run, runS1, runS2 };
