// preprocess.node.test.js
// 预处理步骤测试：segments.json 读取、2-name2text.txt 生成、训练数据检查、meta.json 生成。
// 通过 mock spawn_async + python_helper + paths，不依赖真实 engines/ 目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREPROCESS_PATH = path.join(__dirname, 'preprocess.js');
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
  delete require.cache[require.resolve(PREPROCESS_PATH)];

  const gsvCodeDir = tmpDir('pre-gsv-');

  // mock paths
  const resolvedPaths = require.resolve(PATHS_PATH);
  require.cache[resolvedPaths] = {
    id: resolvedPaths,
    filename: resolvedPaths,
    loaded: true,
    exports: {
      GSV_CODE_DIR: gsvCodeDir,
      GSV_INFER_DIR: gsvCodeDir,
      PRETRAINED: {
        s2G488k: path.join(gsvCodeDir, 's2G.pth'),
        cnhubert: gsvCodeDir,
        bert: gsvCodeDir,
        g2pw: gsvCodeDir,
        svCkpt: path.join(gsvCodeDir, 'sv.pth'),
      },
    },
  };

  // mock spawn_async
  require.cache[require.resolve(SPAWN_PATH)] = {
    id: require.resolve(SPAWN_PATH),
    filename: require.resolve(SPAWN_PATH),
    loaded: true,
    exports: {
      spawnAsync: async (cmd, args, opts) => {
        // 从 env 获取 workDir
        const workDir = (opts && opts.env && opts.env.opt_dir) || process.env.opt_dir || '';
        if (!workDir) return { status: 0, stdout: '', stderr: '' };
        if (args.some(a => a.includes('1-get-text.py'))) {
          fs.writeFileSync(path.join(workDir, '2-name2text-0.txt'), 'clip_001\ttest-voice|ja|テスト\n');
          fs.mkdirSync(path.join(workDir, '3-bert'), { recursive: true });
          fs.writeFileSync(path.join(workDir, '3-bert', 'clip_001.pt'), 'x');
        } else if (args.some(a => a.includes('2-get-hubert-wav32k.py'))) {
          fs.mkdirSync(path.join(workDir, '4-cnhubert'), { recursive: true });
          fs.mkdirSync(path.join(workDir, '5-wav32k'), { recursive: true });
          fs.writeFileSync(path.join(workDir, '4-cnhubert', 'clip_001.pt'), 'x');
          fs.writeFileSync(path.join(workDir, '5-wav32k', 'clip_001.wav'), 'x');
        } else if (args.some(a => a.includes('3-get-semantic.py'))) {
          fs.writeFileSync(path.join(workDir, '6-name2semantic-0.tsv'), 'clip_001\t1 2 3\n');
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
      getCleanEnv: (extra) => ({ ...extra }),
    },
  };

  return { gsvCodeDir, preprocess: require(PREPROCESS_PATH) };
}

function makeCtx(workDir, opts = {}) {
  return {
    workDir,
    inputDir: opts.inputDir || tmpDir('pre-in-'),
    voiceId: 'test-voice',
    language: 'ja',
    config: {
      training: {
        gpt_epochs: 8,
        sovits_epochs: 25,
        version: 'v2',
      },
    },
    setChild: () => {},
  };
}

function createSegmentsJson(workDir, opts = {}) {
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
      text: opts.text || 'テスト',
      lang: opts.lang || 'ja',
      matched: true,
      duration: 0,
    }],
  };
  fs.writeFileSync(path.join(workDir, 'segments.json'), JSON.stringify(segData));
}

function createTrainingData(workDir) {
  // 2-name2text-0.txt (phoneme) — key 用 tab 分隔，与 6-name2semantic-0.tsv 对齐
  fs.writeFileSync(path.join(workDir, '2-name2text-0.txt'), 'clip_001\ttest-voice|ja|テスト\n');
  // 4-cnhubert/
  fs.mkdirSync(path.join(workDir, '4-cnhubert'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '4-cnhubert', 'clip_001.pt'), 'x');
  // 5-wav32k/
  fs.mkdirSync(path.join(workDir, '5-wav32k'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '5-wav32k', 'clip_001.wav'), 'x');
  // 6-name2semantic-0.tsv
  fs.writeFileSync(path.join(workDir, '6-name2semantic-0.tsv'), 'clip_001\t1 2 3\n');
}

// ---------------------------------------------------------------------------
// segments.json 不存在
// ---------------------------------------------------------------------------

test('run: segments.json 不存在时抛错', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /segments\.json not found/
  );
});

// ---------------------------------------------------------------------------
// 2-name2text.txt 已存在 → 跳过生成
// ---------------------------------------------------------------------------

test('run: 2-name2text.txt 已存在时跳过生成', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  // 2-name2text.txt 是 preprocess 生成的中间文件（name|voice|lang|text 格式）
  fs.writeFileSync(path.join(workDir, '2-name2text.txt'), 'clip_001|test-voice|ja|テスト\n');
  createTrainingData(workDir);

  const ctx = makeCtx(workDir);
  const result = await preprocess.run(ctx, () => {});
  assert.ok(result.metaPath);
  assert.ok(fs.existsSync(result.metaPath));
});

// ---------------------------------------------------------------------------
// 训练数据已存在 → 跳过 Python 脚本
// ---------------------------------------------------------------------------

test('run: 训练数据已存在时跳过 Python 脚本', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  createTrainingData(workDir);

  const ctx = makeCtx(workDir);
  const logs = [];
  await preprocess.run(ctx, (msg) => logs.push(msg));
  assert.ok(logs.some(l => l.includes('already present')));
});

// ---------------------------------------------------------------------------
// 6-name2semantic-0.tsv 缺失 → 抛错
// ---------------------------------------------------------------------------

test('run: 6-name2semantic-0.tsv 缺失时抛错', async () => {
  // 使用"空 mock"（不生成任何文件）来验证错误路径
  delete require.cache[require.resolve(PREPROCESS_PATH)];
  const gsvCodeDir = tmpDir('pre-gsv-');
  const resolvedPaths = require.resolve(PATHS_PATH);
  require.cache[resolvedPaths] = {
    id: resolvedPaths, filename: resolvedPaths, loaded: true,
    exports: {
      GSV_CODE_DIR: gsvCodeDir, GSV_INFER_DIR: gsvCodeDir,
      PRETRAINED: { s2G488k: '', cnhubert: '', bert: '', g2pw: '', svCkpt: '' },
    },
  };
  require.cache[require.resolve(SPAWN_PATH)] = {
    id: require.resolve(SPAWN_PATH), filename: require.resolve(SPAWN_PATH), loaded: true,
    exports: { spawnAsync: async () => ({ status: 0, stdout: '', stderr: '' }) },
  };
  require.cache[require.resolve(PYHELP_PATH)] = {
    id: require.resolve(PYHELP_PATH), filename: require.resolve(PYHELP_PATH), loaded: true,
    exports: { getPythonPath: () => process.execPath, getCleanEnv: (extra) => ({ ...extra }) },
  };
  const preprocess = require(PREPROCESS_PATH);

  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  // 创建 2-name2text.txt 但 6-name2semantic-0.tsv 不存在 → needPreprocess=true → mock 不生成 → 最终检查失败
  fs.writeFileSync(path.join(workDir, '2-name2text.txt'), 'clip_001|test-voice|ja|テスト\n');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /6-name2semantic-0\.tsv/
  );
});

// ---------------------------------------------------------------------------
// 4-cnhubert/ 为空 → 抛错
// ---------------------------------------------------------------------------

test('run: 4-cnhubert/ 为空时抛错', async () => {
  // mock 只生成 semantic 文件，不生成 hubert/wav32k → 命中 features are empty 检查
  delete require.cache[require.resolve(PREPROCESS_PATH)];
  const gsvCodeDir = tmpDir('pre-gsv-');
  const resolvedPaths = require.resolve(PATHS_PATH);
  require.cache[resolvedPaths] = {
    id: resolvedPaths, filename: resolvedPaths, loaded: true,
    exports: {
      GSV_CODE_DIR: gsvCodeDir, GSV_INFER_DIR: gsvCodeDir,
      PRETRAINED: { s2G488k: '', cnhubert: '', bert: '', g2pw: '', svCkpt: '' },
    },
  };
  require.cache[require.resolve(SPAWN_PATH)] = {
    id: require.resolve(SPAWN_PATH), filename: require.resolve(SPAWN_PATH), loaded: true,
    exports: {
      spawnAsync: async (cmd, args, opts) => {
        const workDir = (opts && opts.env && opts.env.opt_dir) || process.env.opt_dir || '';
        // 只生成 semantic 文件
        if (args.some(a => a.includes('3-get-semantic.py'))) {
          fs.writeFileSync(path.join(workDir, '6-name2semantic-0.tsv'), 'clip_001\t1 2 3\n');
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
  require.cache[require.resolve(PYHELP_PATH)] = {
    id: require.resolve(PYHELP_PATH), filename: require.resolve(PYHELP_PATH), loaded: true,
    exports: { getPythonPath: () => process.execPath, getCleanEnv: (extra) => ({ ...extra }) },
  };
  const preprocess = require(PREPROCESS_PATH);

  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  fs.writeFileSync(path.join(workDir, '2-name2text.txt'), 'clip_001|test-voice|ja|テスト\n');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /Preprocessing features are empty/
  );
});

// ---------------------------------------------------------------------------
// 5-wav32k/ 为空 → 抛错
// ---------------------------------------------------------------------------

test('run: 5-wav32k/ 为空时抛错', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  createTrainingData(workDir);
  fs.unlinkSync(path.join(workDir, '5-wav32k', 'clip_001.wav'));

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /Preprocessing features are empty/
  );
});

// ---------------------------------------------------------------------------
// phoneme rows = 0 → 抛错
// ---------------------------------------------------------------------------

test('run: phoneme 行数为 0 时抛错', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  createTrainingData(workDir);
  fs.writeFileSync(path.join(workDir, '2-name2text-0.txt'), '');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /Training set is empty.*phoneme/
  );
});

// ---------------------------------------------------------------------------
// semantic rows = 0 → 抛错
// ---------------------------------------------------------------------------

test('run: semantic 行数为 0 时抛错', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  createTrainingData(workDir);
  fs.writeFileSync(path.join(workDir, '6-name2semantic-0.tsv'), '');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /Training set is empty.*semantic/
  );
});

// ---------------------------------------------------------------------------
// 交集 = 0 → 抛错
// ---------------------------------------------------------------------------

test('run: phoneme 与 semantic 交集为 0 时抛错', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  createTrainingData(workDir);
  // phoneme 用不同的 key
  fs.writeFileSync(path.join(workDir, '2-name2text-0.txt'), 'other_name|test-voice|ja|テスト\n');

  const ctx = makeCtx(workDir);
  await assert.rejects(
    () => preprocess.run(ctx, () => {}),
    /do not match at all/
  );
});

// ---------------------------------------------------------------------------
// 正常流程 → 生成 meta.json
// ---------------------------------------------------------------------------

test('run: 正常流程生成 meta.json', async () => {
  const { preprocess } = installStubs();
  const workDir = tmpDir('pre-work-');
  createSegmentsJson(workDir);
  createTrainingData(workDir);

  const ctx = makeCtx(workDir);
  const result = await preprocess.run(ctx, () => {});

  assert.ok(result.metaPath);
  const meta = JSON.parse(fs.readFileSync(result.metaPath, 'utf-8'));
  assert.equal(meta.id, 'test-voice');
  assert.equal(meta.language, 'ja');
  assert.equal(meta.base_version, 'v2');
  assert.equal(meta.segment_total, 1);
  assert.ok(meta.assets);
});
