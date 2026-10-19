// train.node.test.js
// 训练步骤测试：runS1 / runS2 / run 的输入输出映射。
// 通过 mock spawn_async + python_helper + paths，不依赖真实 engines/ 目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TRAIN_PATH = path.join(__dirname, 'train.js');
const PATHS_PATH = path.resolve(__dirname, '..', '..', 'paths');
const SPAWN_PATH = path.join(__dirname, 'spawn_async.js');
const PYHELP_PATH = path.join(__dirname, '..', 'python_helper.js');

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function installStubs() {
  delete require.cache[require.resolve(TRAIN_PATH)];

  const gsvCodeDir = tmpDir('train-gsv-');
  const pretrainedDir = tmpDir('train-pre-');

  // 创建假底模文件
  fs.mkdirSync(path.join(pretrainedDir, 'v2'), { recursive: true });
  fs.writeFileSync(path.join(pretrainedDir, 'v2', 's2G2333k.pth'), 'x');
  fs.writeFileSync(path.join(pretrainedDir, 'v2', 's2D2333k.pth'), 'x');
  fs.writeFileSync(path.join(pretrainedDir, 's1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'), 'x');

  // 创建假的 s2.json 配置（train.js 会读取并修改它）
  fs.mkdirSync(path.join(gsvCodeDir, 'configs'), { recursive: true });
  fs.writeFileSync(path.join(gsvCodeDir, 'configs', 's2.json'), JSON.stringify({
    s2_ckpt_dir: '',
    train: {},
    data: {},
    model: { version: 'v2' },
    name: '',
    save_weight_dir: '',
  }));

  // mock paths
  const resolvedPaths = require.resolve(PATHS_PATH);
  require.cache[resolvedPaths] = {
    id: resolvedPaths,
    filename: resolvedPaths,
    loaded: true,
    exports: {
      GSV_CODE_DIR: gsvCodeDir,
      GSV_PRETRAINED_DIR: pretrainedDir,
    },
  };

  // mock spawn_async
  require.cache[require.resolve(SPAWN_PATH)] = {
    id: require.resolve(SPAWN_PATH),
    filename: require.resolve(SPAWN_PATH),
    loaded: true,
    exports: {
      spawnAsync: async (cmd, args) => {
        const configIdx = args.indexOf('-c');
        if (configIdx >= 0) {
          const configPath = args[configIdx + 1];
          const content = fs.readFileSync(configPath, 'utf-8');
          if (configPath.endsWith('.json')) {
            // S2 配置
            const config = JSON.parse(content);
            const outDir = config.s2_ckpt_dir;
            if (outDir) {
              fs.mkdirSync(outDir, { recursive: true });
              fs.writeFileSync(path.join(outDir, `${config.name}_e25_s100.pth`), 'x');
            }
          } else {
            // S1 配置 (yaml)
            const outDirMatch = content.match(/output_dir:\s*(.+)/);
            const expNameMatch = content.match(/exp_name:\s*(.+)/);
            if (outDirMatch) {
              const outDir = outDirMatch[1].trim();
              const expName = expNameMatch ? expNameMatch[1].trim() : 'test-voice';
              fs.mkdirSync(path.join(outDir, 'ckpt'), { recursive: true });
              fs.writeFileSync(path.join(outDir, 'ckpt', `${expName}-e8.ckpt`), 'x');
            }
          }
        }
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    },
  };

  // mock python_helper
  require.cache[require.resolve(PYHELP_PATH)] = {
    id: require.resolve(PYHELP_PATH),
    filename: require.resolve(PYHELP_PATH),
    loaded: true,
    exports: {
      getPythonPath: () => process.execPath,
      getCleanEnv: () => ({}),
    },
  };

  return { gsvCodeDir, pretrainedDir, train: require(TRAIN_PATH) };
}

function makeCtx(workDir, opts = {}) {
  return {
    workDir,
    inputDir: opts.inputDir || tmpDir('train-in-'),
    voiceId: 'test-voice',
    language: 'ja',
    config: {
      training: {
        gpt_epochs: 8,
        sovits_epochs: 25,
        batch_size: 'auto',
        version: 'v2',
      },
    },
    stepOptions: opts.stepOptions || {},
    setChild: () => {},
    isCancelled: () => false,
  };
}

function createSegmentsJson(workDir) {
  const segData = {
    voice: 'test-voice',
    language: 'ja',
    source_kind: 'slicer_opt',
    total: 1,
    matched: 1,
    segments: [{
      index: 0,
      scene: 'clip_001',
      audio_filename: 'clip_001.wav',
      audio_path: 'slicer_opt/clip_001.wav',
      text: 'テスト',
      lang: 'ja',
      matched: true,
      duration: 0,
    }],
  };
  fs.writeFileSync(path.join(workDir, 'segments.json'), JSON.stringify(segData));
}

function createName2Text(workDir) {
  fs.writeFileSync(path.join(workDir, '2-name2text-0.txt'), 'clip_001|test-voice|ja|テスト\n');
}

function createSemantic(workDir) {
  fs.writeFileSync(path.join(workDir, '6-name2semantic-0.tsv'), 'clip_001\t1 2 3\n');
}

function createHubertWav32k(workDir) {
  const hubertDir = path.join(workDir, '4-cnhubert');
  const wav32kDir = path.join(workDir, '5-wav32k');
  fs.mkdirSync(hubertDir, { recursive: true });
  fs.mkdirSync(wav32kDir, { recursive: true });
  fs.writeFileSync(path.join(hubertDir, 'clip_001.pt'), 'x');
  fs.writeFileSync(path.join(wav32kDir, 'clip_001.wav'), 'x');
}

// ---------------------------------------------------------------------------
// runS1 — 缺少 segments.json
// ---------------------------------------------------------------------------

test('runS1: 缺少 segments.json 时抛错', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  // runS1 先检查 2-name2text.txt，再检查 segments.json
  fs.writeFileSync(path.join(workDir, '2-name2text.txt'), 'clip_001|test-voice|ja|テスト\n');
  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => train.runS1(ctx, () => {}),
    /segments\.json/
  );
});

// ---------------------------------------------------------------------------
// runS2 — 缺少 segments.json
// ---------------------------------------------------------------------------

test('runS2: 缺少 segments.json 时抛错', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => train.runS2(ctx, () => {}),
    /segments\.json/
  );
});

// ---------------------------------------------------------------------------
// runS2 — 4-cnhubert/ 为空
// ---------------------------------------------------------------------------

test('runS2: 4-cnhubert/ 为空时抛错', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  createSegmentsJson(workDir);
  fs.mkdirSync(path.join(workDir, '4-cnhubert'), { recursive: true });
  fs.mkdirSync(path.join(workDir, '5-wav32k'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '5-wav32k', 'clip.wav'), 'x');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => train.runS2(ctx, () => {}),
    /4-cnhubert\/ is empty/
  );
});

// ---------------------------------------------------------------------------
// runS2 — 5-wav32k/ 为空
// ---------------------------------------------------------------------------

test('runS2: 5-wav32k/ 为空时抛错', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  createSegmentsJson(workDir);
  fs.mkdirSync(path.join(workDir, '4-cnhubert'), { recursive: true });
  fs.mkdirSync(path.join(workDir, '5-wav32k'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '4-cnhubert', 'clip.pt'), 'x');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => train.runS2(ctx, () => {}),
    /5-wav32k\/ is empty/
  );
});

// ---------------------------------------------------------------------------
// run — 跳过 S1 和 S2
// ---------------------------------------------------------------------------

test('run: train_s1=false, train_s2=false 时跳过两者', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  const logs = [];
  const ctx = makeCtx(workDir, {
    stepOptions: { train_s1: false, train_s2: false },
  });
  const result = await train.run(ctx, (msg) => logs.push(msg));
  assert.deepEqual(result, {});
  assert.ok(logs.some(l => l.includes('Skip S1')));
  assert.ok(logs.some(l => l.includes('Skip S2')));
});

// ---------------------------------------------------------------------------
// run — 只运行 S1
// ---------------------------------------------------------------------------

test('run: train_s2=false 时只运行 S1', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  createSegmentsJson(workDir);
  createName2Text(workDir);
  createSemantic(workDir);

  const ctx = makeCtx(workDir, {
    stepOptions: { train_s1: true, train_s2: false },
  });
  const result = await train.run(ctx, () => {});
  assert.ok(result.s1OutputDir);
  assert.ok(result.s1Ckpts.length > 0);
});

// ---------------------------------------------------------------------------
// run — 只运行 S2
// ---------------------------------------------------------------------------

test('run: train_s1=false 时只运行 S2', async () => {
  const { train } = installStubs();
  const workDir = tmpDir('train-work-');
  createSegmentsJson(workDir);
  createName2Text(workDir);
  createSemantic(workDir);
  createHubertWav32k(workDir);

  const ctx = makeCtx(workDir, {
    stepOptions: { train_s1: false, train_s2: true },
  });
  const result = await train.run(ctx, () => {});
  assert.ok(result.s2OutputDir);
  assert.ok(result.s2Models.length > 0);
});
