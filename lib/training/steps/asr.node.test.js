// asr.node.test.js
// ASR 步骤测试：runAsr / run 的输入输出映射、.list 生成、segments.json 生成。
// 通过 mock spawn_async + python_helper + paths，不依赖真实 engines/ 目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ASR_PATH = path.join(__dirname, 'asr.js');
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
  delete require.cache[require.resolve(ASR_PATH)];

  const asrDir = tmpDir('asr-dir-');
  const fasterWhisperDir = tmpDir('asr-fw-');

  // mock paths
  const resolvedPaths = require.resolve(PATHS_PATH);
  require.cache[resolvedPaths] = {
    id: resolvedPaths,
    filename: resolvedPaths,
    loaded: true,
    exports: {
      ASR_DIR: asrDir,
      FASTER_WHISPER_DIR: fasterWhisperDir,
    },
  };

  // mock spawn_async
  require.cache[require.resolve(SPAWN_PATH)] = {
    id: require.resolve(SPAWN_PATH),
    filename: require.resolve(SPAWN_PATH),
    loaded: true,
    exports: {
      spawnAsync: async (cmd, args) => {
        // 找到 -o 参数（输出目录）
        const oi = args.indexOf('-o');
        const outDir = oi >= 0 ? args[oi + 1] : null;
        if (!outDir) return { status: 0, stdout: '', stderr: '' };

        // 模拟 ASR Python 脚本生成 .list 文件
        fs.mkdirSync(outDir, { recursive: true });
        const listContent = [
          '/fake/path/clip_001.wav|speaker|JA|テスト',
          '/fake/path/clip_002.wav|speaker|JA|こんにちは',
        ].join('\n') + '\n';
        fs.writeFileSync(path.join(outDir, 'result.list'), listContent);

        // 生成置信度旁车
        fs.writeFileSync(path.join(outDir, 'result.conf.json'), JSON.stringify({
          'clip_001.wav': { confidence: 0.95, words: [{ word: 'テスト', confidence: 0.95 }] },
          'clip_002.wav': { confidence: 0.88, words: [{ word: 'こんにちは', confidence: 0.88 }] },
        }));

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

  return { asr: require(ASR_PATH) };
}

function makeSrcDir(files = ['clip_001.wav', 'clip_002.wav']) {
  const dir = tmpDir('asr-src-');
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// runAsr — 未知 sourceKind
// ---------------------------------------------------------------------------

test('runAsr: 未知 sourceKind 抛错', async () => {
  const { asr } = installStubs();
  const srcDir = makeSrcDir();
  const outDir = tmpDir('asr-out-');
  await assert.rejects(
    () => asr.runAsr({
      srcDir,
      sourceKind: 'unknown',
      language: 'ja',
      voiceId: 'test-voice',
      outDir,
      config: { steps: { asr: { params: {} } } },
    }, () => {}),
    /Unknown ASR sourceKind/
  );
});

// ---------------------------------------------------------------------------
// runAsr — srcDir 不存在
// ---------------------------------------------------------------------------

test('runAsr: srcDir 不存在抛错', async () => {
  const { asr } = installStubs();
  const outDir = tmpDir('asr-out-');
  await assert.rejects(
    () => asr.runAsr({
      srcDir: '/nonexistent/path',
      sourceKind: 'slicer_opt',
      language: 'ja',
      voiceId: 'test-voice',
      outDir,
      config: { steps: { asr: { params: {} } } },
    }, () => {}),
    /ASR source directory does not exist/
  );
});

// ---------------------------------------------------------------------------
// runAsr — srcDir 无音频文件
// ---------------------------------------------------------------------------

test('runAsr: srcDir 无音频文件抛错', async () => {
  const { asr } = installStubs();
  const srcDir = tmpDir('asr-src-');
  fs.writeFileSync(path.join(srcDir, 'readme.txt'), 'x');
  const outDir = tmpDir('asr-out-');
  await assert.rejects(
    () => asr.runAsr({
      srcDir,
      sourceKind: 'slicer_opt',
      language: 'ja',
      voiceId: 'test-voice',
      outDir,
      config: { steps: { asr: { params: {} } } },
    }, () => {}),
    /ASR source directory has no audio files/
  );
});

// ---------------------------------------------------------------------------
// runAsr — 正常流程生成 .list 和 .conf.json
// ---------------------------------------------------------------------------

test('runAsr: 正常流程生成 .list 和 .conf.json', async () => {
  const { asr } = installStubs();
  const srcDir = makeSrcDir();
  const outDir = tmpDir('asr-out-');

  const result = await asr.runAsr({
    srcDir,
    sourceKind: 'slicer_opt',
    language: 'ja',
    voiceId: 'test-voice',
    outDir,
    config: { steps: { asr: { params: {} } } },
  }, () => {});

  assert.equal(result.listName, 'slicer_opt.list');
  assert.equal(result.sourceKind, 'slicer_opt');
  assert.ok(result.listPath);
  assert.ok(fs.existsSync(result.listPath));

  const content = fs.readFileSync(result.listPath, 'utf-8');
  assert.ok(content.includes('slicer_opt/clip_001.wav'));
  assert.ok(content.includes('slicer_opt/clip_002.wav'));

  // 置信度旁车
  const confPath = path.join(outDir, 'slicer_opt.conf.json');
  assert.ok(fs.existsSync(confPath));
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf-8'));
  assert.equal(conf['clip_001.wav'].confidence, 0.95);
});

// ---------------------------------------------------------------------------
// runAsr — raw sourceKind
// ---------------------------------------------------------------------------

test('runAsr: raw sourceKind 生成 raw_opt.list', async () => {
  const { asr } = installStubs();
  const srcDir = makeSrcDir(['raw_001.wav']);
  const outDir = tmpDir('asr-out-');

  const result = await asr.runAsr({
    srcDir,
    sourceKind: 'raw',
    language: 'ja',
    voiceId: 'test-voice',
    outDir,
    config: { steps: { asr: { params: {} } } },
  }, () => {});

  assert.equal(result.listName, 'raw_opt.list');
  const content = fs.readFileSync(result.listPath, 'utf-8');
  assert.ok(content.includes('raw/raw_001.wav'));
});

// ---------------------------------------------------------------------------
// runAsr — auto 语言检测
// ---------------------------------------------------------------------------

test('runAsr: auto 语言使用检测到的语言', async () => {
  const { asr } = installStubs();
  const srcDir = makeSrcDir();
  const outDir = tmpDir('asr-out-');

  const result = await asr.runAsr({
    srcDir,
    sourceKind: 'slicer_opt',
    language: 'auto',
    voiceId: 'test-voice',
    outDir,
    config: { steps: { asr: { params: {} } } },
  }, () => {});

  const content = fs.readFileSync(result.listPath, 'utf-8');
  // auto 模式下，检测到的语言（JA）应写入 LANG 列
  assert.ok(content.includes('|JA|'));
});

// ---------------------------------------------------------------------------
// run — 无音频源抛错
// ---------------------------------------------------------------------------

test('run: 无音频源时抛错', async () => {
  const { asr } = installStubs();
  const workDir = tmpDir('asr-work-');
  const inputDir = tmpDir('asr-in-');
  const ctx = {
    workDir,
    inputDir,
    voiceId: 'test-voice',
    language: 'ja',
    config: { steps: { asr: { params: {} } } },
    setChild: () => {},
  };
  await assert.rejects(
    () => asr.run(ctx, () => {}),
    /no recognizable audio source found/
  );
});

// ---------------------------------------------------------------------------
// run — 正常流程生成 segments.json
// ---------------------------------------------------------------------------

test('run: 正常流程生成 segments.json', async () => {
  const { asr } = installStubs();
  const workDir = tmpDir('asr-work-');
  const inputDir = tmpDir('asr-in-');

  // 创建 raw 音频
  fs.writeFileSync(path.join(inputDir, 'clip_001.wav'), 'x');
  fs.writeFileSync(path.join(inputDir, 'clip_002.wav'), 'x');

  const ctx = {
    workDir,
    inputDir,
    voiceId: 'test-voice',
    language: 'ja',
    config: { steps: { asr: { params: {} } } },
    setChild: () => {},
  };

  const result = await asr.run(ctx, () => {});

  assert.ok(result.segmentsPath);
  assert.equal(result.segmentCount, 2);
  assert.equal(result.sourceKind, 'raw');
  assert.ok(fs.existsSync(result.segmentsPath));

  const segData = JSON.parse(fs.readFileSync(result.segmentsPath, 'utf-8'));
  assert.equal(segData.voice, 'test-voice');
  assert.equal(segData.source_kind, 'raw');
  assert.equal(segData.total, 2);
  assert.ok(Array.isArray(segData.segments));
});

// ---------------------------------------------------------------------------
// run — 切片存在时优先使用切片
// ---------------------------------------------------------------------------

test('run: 切片存在时优先使用 slicer_opt', async () => {
  const { asr } = installStubs();
  const workDir = tmpDir('asr-work-');
  const inputDir = tmpDir('asr-in-');

  // 创建切片
  const slicerDir = path.join(workDir, 'slicer_opt');
  fs.mkdirSync(slicerDir, { recursive: true });
  fs.writeFileSync(path.join(slicerDir, 'slice_001.wav'), 'x');

  const ctx = {
    workDir,
    inputDir,
    voiceId: 'test-voice',
    language: 'ja',
    config: { steps: { asr: { params: {} } } },
    setChild: () => {},
  };

  const result = await asr.run(ctx, () => {});
  assert.equal(result.sourceKind, 'slicer_opt');
  assert.equal(result.listName, 'slicer_opt.list');
});
