// 训练步骤：调用 gsv-code/ 里的 s1_train.py 与 s2_train.py，训练 GPT 与 SoVITS 两半模型。
// 代码目录与权重目录取自 lib/paths.js，解释器由 lib/training/python_helper.js 解析。
// 本文件只负责组装训练配置并调用训练脚本，不判断训练结果的好坏。
// 一个版本集一次训练可产出多个 SoVITS 版本，产物清单写进 workDir/.s2_products.json 供收尾步读取。

const path = require('path');
const fs = require('fs');
const { getPythonPath, getCleanEnv } = require('../python_helper');
const { spawnAsync } = require('./spawn_async');
const { normalizeVersion } = require('../version');

const { GSV_CODE_DIR: GSV_CODE, GSV_PRETRAINED_DIR: PRETRAINED_DIR } = require('../../paths');

// 按候选相对路径依次查找底模，返回首个存在的绝对路径；全部缺失则抛出列出所有搜索位置的错误。
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

// 训练失败时把完整的 stdout 与 stderr 落到 workDir/logs/<step>.log，便于排查。写不进去时返回 null。
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

// 批大小。取值范围 1 到 16；不是数字或小于 1 时用 fallback。
function resolveBatch(v, fallback) {
  if (v === undefined || v === null || v === 'auto') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : fallback;
}

// 训练子进程的环境变量。PYTHONPATH 指到 gsv-code 的上一级，训练脚本才能 import 到自己那套模块。
function buildTrainEnv() {
  return getCleanEnv({
    PYTHONPATH: [path.join(GSV_CODE, '..')].join(path.delimiter),
    CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0',
    PYTHONUNBUFFERED: '1',
    // torch、numpy MKL、faiss、onnxruntime 各自带一份 OpenMP 运行库，Windows 上重复加载
    // libiomp5md.dll 会在初始化或收尾时让进程原生崩溃。容忍它，而不是让训练崩掉。
    KMP_DUPLICATE_LIB_OK: 'TRUE',
  });
}

// 训练数据文件的查找器。先在 workDir 找，再在 inputDir 找；两处都没有则抛错。
function makeCheckFile(ctx) {
  return (name) => {
    const wd = path.join(ctx.workDir, name);
    if (fs.existsSync(wd)) return wd;
    const id = path.join(ctx.inputDir, name);
    if (fs.existsSync(id)) return id;
    throw new Error(`File "${name}" not found in workDir or inputDir`);
  };
}

// S1 训练：训练 GPT 这一半，产出 <voiceId>-e<epoch>.ckpt 权重。
async function runS1(ctx, log) {
  const { workDir, voiceId, config } = ctx;
  const trainCfg = config.training;
  const checkFile = makeCheckFile(ctx);

  log(`Starting S1 training (GPT): voice=${voiceId}`);
  log(`GPT epochs: ${trainCfg.gpt_epochs}`);

  // 带 -0 后缀的转写结果优先，没有则用不带后缀的那份。
  let name2textPath;
  try {
    name2textPath = checkFile('2-name2text-0.txt');
  } catch {
    name2textPath = checkFile('2-name2text.txt');
  }

  checkFile('segments.json'); // 预处理必须已经产出 segments

  log('\n=== S1 Training (GPT) ===');

  const s1Script = path.join(GSV_CODE, 's1_train.py');
  const s1Config = path.join(GSV_CODE, 'configs', 's1longer.yaml');

  // GPT 侧的底模只有一份，v2 / v2Pro / v2ProPlus 共用它，所以放在 v2/ 下。
  // 后两条是旧布局与更早的扁平放法，供尚未搬迁底模的安装回退。
  let pretrainedS1 = resolvePretrained('GPT(s1)', [
    path.join('v2', 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'),
    path.join('gsv-v2final', 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'),
    's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt',
  ]);

  // S1 声学精修：从父资产发布的 GPT 权重继续训练，而不是从通用底模开始。
  // 发布的 .ckpt 里含 {weight, config, info}，s1_train 把它当作 pretrained_s1 读入。
  const s1Refine = ctx.refinement && /s1/i.test(String(ctx.refinement.refinement_type || ''))
    ? ctx.refinement : null;
  if (s1Refine && s1Refine.base_s1_checkpoint && fs.existsSync(s1Refine.base_s1_checkpoint)) {
    pretrainedS1 = s1Refine.base_s1_checkpoint;
    log(`[Refine] S1 will continue from parent checkpoint: ${pretrainedS1}`);
  } else if (s1Refine && s1Refine.base_s1_checkpoint) {
    log(`[Refine] ⚠ parent S1 checkpoint not found (${s1Refine.base_s1_checkpoint}); falling back to base pretrained model`);
  }

  // S1 产物目录：logs_s1/<voiceId>。
  const s1OutputDir = path.join(workDir, 'logs_s1', voiceId);
  fs.mkdirSync(s1OutputDir, { recursive: true });

  // 准备 S1 训练配置。
  // GSV 只在 (当前轮数 + 1) % save_every_n_epoch == 0 时写权重；保存间隔大于总轮数时，
  // 一次权重都不会落盘，步骤会以「未生成 checkpoint」失败（例如 3 轮、间隔 4）。
  // 因此把间隔压到不超过总轮数，保证最后一轮一定产出权重。
  const gptEpochs = Math.max(1, Number(trainCfg.gpt_epochs) || 20);
  // S1 有自己的保存间隔，默认 4；只带通用 save_every_n_epoch 的旧配方同样能用。
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
    // 解释器或 DataLoader 子进程在收尾时原生崩溃（Windows 上是访问违例 0xC0000005，
    // 退出码 3221225477），可能发生在所有轮次训练结束、ModelCheckpoint 也已经写完权重之后。
    // 这时模型在盘上是完整的，保留它比丢掉一次本来成功的训练好。
    // 只在「最后一个计划保存点」的权重存在时才保留：那是本次训练最后一个会落盘的轮次，
    // 也正是完整训练会交付的那一份。崩得更早则这个文件不存在，判定为失败。
    // 只在「最后一个计划保存点」的权重存在时才保留：那是本次训练最后一个会落盘的轮次，
    // 也正是完整训练会交付的那一份。崩得更早则这个文件不存在，判定为失败。
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

// S2 训练：训练 SoVITS 这一半，产出 <voiceId>_e<epoch>_s<step>.pth 权重。
async function runS2(ctx, log) {
  const { workDir, voiceId, config } = ctx;
  const trainCfg = config.training;
  const checkFile = makeCheckFile(ctx);
  const trainEnv = buildTrainEnv();

  log(`Starting S2 training (SoVITS): voice=${voiceId}`);
  log(`SoVITS epochs: ${trainCfg.sovits_epochs}`);
  checkFile('segments.json'); // 预处理必须已经产出 segments

  log('\n=== S2 Training (SoVITS) ===');

  const s2ConfigPath = path.join(GSV_CODE, 'configs', 's2.json');

  // 训练数据目录必须存在且非空。
  const hubertDir = checkFile('4-cnhubert');
  const wav32kDir = checkFile('5-wav32k');
  if (!fs.existsSync(hubertDir) || fs.readdirSync(hubertDir).length === 0) {
    throw new Error('4-cnhubert/ is empty; run preprocessing first');
  }
  if (!fs.existsSync(wav32kDir) || fs.readdirSync(wav32kDir).length === 0) {
    throw new Error('5-wav32k/ is empty; run preprocessing first');
  }

  // 一次训练可以产出多个 SoVITS 版本：versions[] 优先，缺省回退单 version，再缺省 v2。
  // 单版本时行为与目录与只产一个版本完全一致。
  let trainVersions = (Array.isArray(trainCfg.versions) && trainCfg.versions.length)
    ? trainCfg.versions.map(normalizeVersion)
    : [normalizeVersion(trainCfg.version || trainCfg.model_version || trainCfg.sovits_version)];
  trainVersions = trainVersions.filter((v, i) => trainVersions.indexOf(v) === i); // 去重保序
  log(`S2 target versions: ${trainVersions.join(', ')}`);

  // 底模按版本选择：v2 优先真正的 v2 底模 s2G2333k（回退 s2G488k 走 shape-safe）；
  // v2Pro / v2ProPlus 用各自的 Pro 底模。
  //
  // 每个列表都是「新布局在前、旧布局在后」：新装或已跑过 Move-BaseModels.ps1 的
  // 机器命中第一条，尚未搬迁底模的机器继续命中后面的旧路径。两种布局都能训。
  const _S2G_CANDS = {
    v2: ['v2/s2G2333k.pth',
         'gsv-v2final/s2G2333k.pth', 'gsv-v2final-pretrained/s2G2333k.pth', 's2G2333k.pth',
         'v1/s2G488k.pth', 'v2Pro/s2G488k.pth', 's2G488k.pth', 'gsv-v2final/s2G488k.pth'],
    v2Pro: ['v2Pro/s2Gv2Pro.pth'],
    v2ProPlus: ['v2ProPlus/s2Gv2ProPlus.pth', 'v2Pro/s2Gv2ProPlus.pth'],
  };
  const _S2D_CANDS = {
    v2: ['v2/s2D2333k.pth',
         'gsv-v2final/s2D2333k.pth', 'gsv-v2final-pretrained/s2D2333k.pth', 's2D2333k.pth',
         'v1/s2D488k.pth', 'v2Pro/s2D488k.pth', 's2D488k.pth', 'gsv-v2final/s2D488k.pth'],
    v2Pro: ['v2Pro/s2Dv2Pro.pth'],
    v2ProPlus: ['v2ProPlus/s2Dv2ProPlus.pth', 'v2Pro/s2Dv2ProPlus.pth'],
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

  // S2 声学精修：从父资产发布的 SoVITS 生成器继续训练，而不是从通用底模开始。
  // 父资产的 .pth 是生成器权重（savee() 的产物），与同版本的 s2_train 的 pretrained_s2G
  // 载入器形状兼容。判别器没有发布版本，仍用底模；这是标准的热启动精修。
  // 精修时只跑选中的那个版本，保证形状对得上。
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

    // 单版本沿用旧目录 logs_s2/<voiceId>；多版本用 logs_s2_<version>/<voiceId> 隔离各版本产物。
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

    // 准备 S2 配置，每个版本一份临时文件，避免并发或覆盖冲突。
    const s2Config = JSON.parse(fs.readFileSync(s2ConfigPath, 'utf-8'));
    s2Config.s2_ckpt_dir = s2OutputDir;
    // 与 S1 同样的压法：s2_train.py 只在轮数 % save_every_epoch == 0 时保存权重，
    // 间隔大于总轮数则一个 .pth 都不会有，步骤随之失败。
    const sovitsEpochs = Math.max(1, Number(trainCfg.sovits_epochs) || 10);
    s2Config.train.epochs = sovitsEpochs;
    // S2 有自己的保存间隔，默认 5。
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
    // S2 进阶参数
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

    // 确保训练开始前保存目录已存在。
    fs.mkdirSync(s2OutputDir, { recursive: true });

    // 底模路径以运行时解析的结果为准，覆盖模板里可能过期的绝对路径。
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
      // 与 S1 同样的保留逻辑：收尾时的原生崩溃（Windows 上是访问违例 0xC0000005，
      // 退出码 3221225477）可能发生在最后一轮训完、savee() 也已经写完可用权重之后。
      // savee 产出的文件名是 "<name>_e<epoch>_s<step>.pth"，且只在 save_every_epoch
      // 的整数倍的轮次保存，因此检查最后一个计划保存轮次。该权重存在即判定模型完整。
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

  // 写多产物清单，供收尾步骤按版本各自命名与记录（版本以清单为准）。
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

// 兼容旧的单一 train 步骤：按 stepOptions 分别决定是否跑 S1 与 S2。
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
