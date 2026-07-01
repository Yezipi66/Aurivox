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

const GSV_CODE = path.join(__dirname, '..', 'gsv_code');
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

async function run(ctx, log) {
  const { workDir, voiceId, config } = ctx;
  const trainCfg = config.training;

  log(`开始训练: voice=${voiceId}`);
  log(`GPT 轮数: ${trainCfg.gpt_epochs}, SoVITS 轮数: ${trainCfg.sovits_epochs}`);

  // 检查训练数据 (先检查 workDir，再检查 inputDir，找不到则抛异常)
  const checkFile = (name) => {
    const wd = path.join(workDir, name);
    if (fs.existsSync(wd)) return wd;
    const id = path.join(ctx.inputDir, name);
    if (fs.existsSync(id)) return id;
    throw new Error(`File "${name}" not found in workDir or inputDir`);
  };

  // 2-name2text-0.txt 优先，否则 2-name2text.txt
  let name2textPath;
  try {
    name2textPath = checkFile('2-name2text-0.txt');
  } catch {
    name2textPath = checkFile('2-name2text.txt');
  }

  const segmentsPath = checkFile('segments.json');

  // ===== S1 训练 =====
  log('\n=== S1 训练 (GPT) ===');

  const s1Script = path.join(GSV_CODE, 's1_train.py');
  const s1Config = path.join(GSV_CODE, 'configs', 's1longer.yaml');

  const pretrainedS1 = path.join(__dirname, '..', 'gsv-tools', 'pretrained',
    'gsv-v2final', 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt');

  if (!fs.existsSync(pretrainedS1)) {
    throw new Error('预训练 S1 模型不存在: ' + pretrainedS1);
  }

  // 创建 S1 输出目录
  const s1OutputDir = path.join(workDir, 'logs_s1', voiceId);
  fs.mkdirSync(s1OutputDir, { recursive: true });

  function resolveBatch(v, fallback) {
    if (v === undefined || v === null || v === 'auto') return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 16) : fallback;
  }

// 准备 S1 训练配置
  // GSV only writes a weight checkpoint when (current_epoch+1) % save_every_n_epoch == 0
  // (s1_train.py L50). If the interval exceeds the total epoch count, NO checkpoint is
  // ever saved and the step fails with "未生成 checkpoint" (e.g. 3 epochs, interval 4).
  // Clamp the interval to the epoch count so the final epoch always produces a ckpt.
  const gptEpochs = Math.max(1, Number(trainCfg.gpt_epochs) || 20);
  const s1SaveEvery = Math.min(Math.max(1, Number(trainCfg.save_every_n_epoch) || 4), gptEpochs);
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

  log(`S1 输出: ${s1OutputDir}`);
  const s1Cmd = [PYTHON, s1Script, '-c', s1TmpConfig];
  log(`执行: ${s1Cmd.join(' ')}`);

  const trainEnv = getCleanEnv({
    PYTHONPATH: [path.join(GSV_CODE, '..')].join(path.delimiter),
    CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0',
    PYTHONUNBUFFERED: '1',
  });

  const s1Result = await spawnAsync(s1Cmd[0], s1Cmd.slice(1), {
    timeout: 86400000,
    env: trainEnv,
    onChild: (proc) => ctx.setChild(proc),
    onStdout: (s) => log(`[S1] ${s.trimEnd()}`),
    onStderr: (s) => log(`[S1:err] ${s.trimEnd()}`),
  });
  if (s1Result.status !== 0) {
    const logPath = writeStepLog(workDir, 's1', s1Result.stdout, s1Result.stderr);
    const suffix = logPath ? `（详见 ${logPath}）` : '';
    throw new Error(`S1 训练失败 (exit code ${s1Result.status}): ${s1Result.stderr.slice(-300)}${suffix}`);
  }
  if (s1Result.stdout) log(`S1 stdout: ${s1Result.stdout.slice(-500)}`);
  if (s1Result.stderr) log(`S1 stderr: ${s1Result.stderr.slice(-500)}`);

  // 查找 S1 checkpoint
  const s1CkptDir = path.join(s1OutputDir, 'ckpt');
  const s1Ckpts = fs.existsSync(s1CkptDir) ? fs.readdirSync(s1CkptDir).filter(f => f.endsWith('.ckpt')) : [];
  if (s1Ckpts.length === 0) throw new Error('S1 训练未生成 checkpoint');
  const latestS1 = path.join(s1CkptDir, s1Ckpts.slice().sort((a, b) => {
    const ea = parseInt(a.match(/-e(\d+)/)?.[1] || '0', 10);
    const eb = parseInt(b.match(/-e(\d+)/)?.[1] || '0', 10);
    return ea - eb;
  }).pop());
  log(`S1 完成: ${latestS1}`);

  // ===== S2 训练 =====
  log('\n=== S2 训练 (SoVITS) ===');

  const s2ConfigPath = path.join(GSV_CODE, 'configs', 's2.json');

  // 检查 S2 训练数据 (先检查 workDir，再检查 inputDir)
  const hubertDir = checkFile('4-cnhubert');
  const wav32kDir = checkFile('5-wav32k');
  if (!fs.existsSync(hubertDir) || fs.readdirSync(hubertDir).length === 0) {
    throw new Error('4-cnhubert/ 目录为空，请先完成预处理');
  }
  if (!fs.existsSync(wav32kDir) || fs.readdirSync(wav32kDir).length === 0) {
    throw new Error('5-wav32k/ 目录为空，请先完成预处理');
  }

  const pretrainedS2G = path.join(__dirname, '..', 'gsv-tools', 'pretrained', 'v2Pro', 's2G488k.pth');
  const pretrainedS2D = path.join(__dirname, '..', 'gsv-tools', 'pretrained', 'v2Pro', 's2D488k.pth');
  if (!fs.existsSync(pretrainedS2G) || !fs.existsSync(pretrainedS2D)) {
    throw new Error('预训练 S2 模型不存在');
  }

  // 创建 S2 输出目录和实验目录
  const s2OutputDir = path.join(workDir, 'logs_s2', voiceId);
  const s2ExpDir = path.join(s2OutputDir, '44k');
  fs.mkdirSync(s2ExpDir, { recursive: true });

  // 确保 workDir 存在
  fs.mkdirSync(workDir, { recursive: true });

  // 确保训练数据在 workDir 下 (如果不在，从 inputDir 复制)
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
    log(`  复制 ${name} 从 inputDir`);
  };
  copyData('2-name2text.txt');
  copyData('2-name2text-0.txt');
  copyData('4-cnhubert');
  copyData('5-wav32k');
  copyData('6-name2semantic-0.tsv');

  // 复制训练数据到 S2 实验目录
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

  // 准备 S2 配置 — 写入临时文件，避免并发冲突
  const s2Config = JSON.parse(fs.readFileSync(s2ConfigPath, 'utf-8'));
  s2Config.s2_ckpt_dir = s2OutputDir;
  // Same clamp as S1: s2_train.py L520 saves weights only when epoch % save_every_epoch == 0,
  // so an interval larger than the epoch count yields no .pth and the step fails.
  const sovitsEpochs = Math.max(1, Number(trainCfg.sovits_epochs) || 10);
  s2Config.train.epochs = sovitsEpochs;
  s2Config.train.batch_size = resolveBatch(trainCfg.batch_size, 4);

  // Learning rate
  if (trainCfg.learning_rate !== undefined &&
      trainCfg.learning_rate !== null &&
      trainCfg.learning_rate !== 'default') {
    const lr = Number(trainCfg.learning_rate);
    if (Number.isFinite(lr) && lr > 0 && lr <= 1) {
      s2Config.train.learning_rate = lr;
      log(`S2 learning rate override: ${lr}`);
    }
  }

  s2Config.train.fp16_run = trainCfg.fp16_run !== false;
  s2Config.train.save_every_epoch = Math.min(Math.max(1, Number(trainCfg.save_every_n_epoch) || 4), sovitsEpochs);
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
  s2Config.model.version = s2Config.model.version || 'v2';
  s2Config.name = voiceId;
  s2Config.save_weight_dir = s2OutputDir;

  // Ensure save directory exists before training starts
  fs.mkdirSync(s2OutputDir, { recursive: true });

  const s2TmpConfig = path.join(workDir, 's2_train_config.json');
  fs.writeFileSync(s2TmpConfig, JSON.stringify(s2Config, null, 2));

  log(`S2 输出: ${s2OutputDir}`);
  log(`S2 exp_dir: ${s2Config.data.exp_dir}`);
  log(`S2 config written to: ${s2TmpConfig}`);

  const s2Cmd = [PYTHON, 's2_train.py', '-c', s2TmpConfig];
  log(`执行: ${s2Cmd.join(' ')} (cwd=${GSV_CODE})`);

  const s2Result = await spawnAsync(s2Cmd[0], s2Cmd.slice(1), {
    cwd: GSV_CODE,
    timeout: 86400000,
    env: trainEnv,
    onChild: (proc) => ctx.setChild(proc),
    onStdout: (s) => log(`[S2] ${s.trimEnd()}`),
    onStderr: (s) => log(`[S2:err] ${s.trimEnd()}`),
  });
  if (s2Result.status !== 0) {
    const logPath = writeStepLog(workDir, 's2', s2Result.stdout, s2Result.stderr);
    const suffix = logPath ? `（详见 ${logPath}）` : '';
    throw new Error(`S2 训练失败 (exit code ${s2Result.status}): ${s2Result.stderr.slice(-300)}${suffix}`);
  }
  if (s2Result.stdout) log(`S2 stdout: ${s2Result.stdout.slice(-500)}`);
  if (s2Result.stderr) log(`S2 stderr: ${s2Result.stderr.slice(-500)}`);

  // 查找 S2 模型
  const s2Models = [];
  for (const item of fs.readdirSync(s2OutputDir)) {
    const p = path.join(s2OutputDir, item);
    if (fs.statSync(p).isDirectory()) {
      s2Models.push(...fs.readdirSync(p).filter(f => f.endsWith('.pth')));
    } else if (item.endsWith('.pth')) {
      s2Models.push(item);
    }
  }

  log(`S2 完成, 模型: ${s2Models.length}`);

  return { s1OutputDir, s2OutputDir, s1Ckpts, s2Models };
}

module.exports = { run };
