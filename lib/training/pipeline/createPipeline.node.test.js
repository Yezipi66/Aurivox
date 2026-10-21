// createPipeline.node.test.js
// Pipeline 工厂公开接口测试：状态机、步骤调度、取消、断点恢复。
// 所有测试通过 os.tmpdir() 构造 fixture，不依赖真实 engines/ 目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CREATE_PIPELINE_PATH = path.join(__dirname, 'createPipeline.js');
const PATHS_PATH = path.resolve(__dirname, '..', '..', 'paths');
const PURE_PATH = path.join(__dirname, 'pure.js');
const PRON_LEXICON_PATH = path.join(__dirname, 'pronLexicon.js');
const STEPS_PATH = path.join(__dirname, 'steps.js');
const WORKSPACE_PATH = path.join(__dirname, 'workspace.js');
const TASK_STORE_PATH = path.join(__dirname, 'taskStore.js');

// 辅助函数

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function installStubs() {
  delete require.cache[require.resolve(CREATE_PIPELINE_PATH)];

  const stagingRoot = tmpDir('cp-staging-');
  const assetsRoot = tmpDir('cp-assets-');

  // mock paths
  const resolvedPaths = require.resolve(PATHS_PATH);
  require.cache[resolvedPaths] = {
    id: resolvedPaths,
    filename: resolvedPaths,
    loaded: true,
    exports: {
      ASSETS_ROOT: assetsRoot,
      STAGING_ROOT: stagingRoot,
      PRON_LEXICON_DIR: tmpDir('cp-pron-'),
    },
  };

  // mock pure
  const resolvedPure = require.resolve(PURE_PATH);
  require.cache[resolvedPure] = {
    id: resolvedPure,
    filename: resolvedPure,
    loaded: true,
    exports: {
      parseListToSegments: (content) => [],
      mergeCustomParams: (base, custom) => base,
      classifyFailure: (msg) => ({ reasonCode: 'error', reason: msg, recoverable: true }),
    },
  };

  // mock pronLexicon
  const resolvedPron = require.resolve(PRON_LEXICON_PATH);
  require.cache[resolvedPron] = {
    id: resolvedPron,
    filename: resolvedPron,
    loaded: true,
    exports: {
      snapshotPronLexicon: () => ({ files: {} }),
    },
  };

  // mock steps
  const resolvedSteps = require.resolve(STEPS_PATH);
  require.cache[resolvedSteps] = {
    id: resolvedSteps,
    filename: resolvedSteps,
    loaded: true,
    exports: {
      STEP_ORDER: ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'],
    },
  };

  // mock workspace
  const resolvedWorkspace = require.resolve(WORKSPACE_PATH);
  require.cache[resolvedWorkspace] = {
    id: resolvedWorkspace,
    filename: resolvedWorkspace,
    loaded: true,
    exports: {
      copyWorkDirUpstream: () => {},
      clearFromStep: () => {},
      clearStepOutputs: () => {},
      pruneCorruptCheckpoints: () => {},
    },
  };

  // mock taskStore
  const resolvedTaskStore = require.resolve(TASK_STORE_PATH);
  const tasksMap = new Map();
  require.cache[resolvedTaskStore] = {
    id: resolvedTaskStore,
    filename: resolvedTaskStore,
    loaded: true,
    exports: {
      tasks: tasksMap,
      cleanupOldTasks: () => {},
    },
  };

  return { createPipeline: require(CREATE_PIPELINE_PATH).createPipeline, stagingRoot, assetsRoot };
}

function makePipeline(opts = {}) {
  const { createPipeline } = installStubs();
  const pipeline = createPipeline({
    voiceId: 'test-voice',
    language: 'ja',
    inputDir: opts.inputDir || tmpDir('cp-in-'),
    stepOptions: {
      denoise: false,
      slice: false,
      asr: false,
      preprocess: false,
      train_s1: false,
      train_s2: false,
      finalize: false,
      promote: false,
    },
    ...opts.overrides,
  });
  return { pipeline };
}

// getStatus — 初始状态

test('getStatus: 初始状态为 pending，所有步骤 pending', () => {
  const { pipeline } = makePipeline();
  const s = pipeline.getStatus();
  assert.equal(s.status, 'pending');
  assert.equal(s.voiceId, 'test-voice');
  assert.equal(s.language, 'ja');
  assert.equal(s.currentStep, null);
  assert.equal(s.startedAt, null);
  assert.equal(s.finishedAt, null);
  assert.equal(s.awaitingReview, false);
  assert.equal(s.reviewStage, null);
  assert.ok(s.steps);
});

test('getStatus: 返回的 steps 包含全部 8 个步骤', () => {
  const { pipeline } = makePipeline();
  const s = pipeline.getStatus();
  const keys = Object.keys(s.steps);
  assert.ok(keys.includes('denoise'));
  assert.ok(keys.includes('slice'));
  assert.ok(keys.includes('asr'));
  assert.ok(keys.includes('preprocess'));
  assert.ok(keys.includes('train_s1'));
  assert.ok(keys.includes('train_s2'));
  assert.ok(keys.includes('finalize'));
  assert.ok(keys.includes('promote'));
});

test('getStatus: 未启动时 resumeOf 为 null', () => {
  const { pipeline } = makePipeline();
  const s = pipeline.getStatus();
  assert.equal(s.resumeOf, null);
  assert.equal(s.resumeMode, null);
});

// getLogs — 日志

test('getLogs: 初始为空数组', () => {
  const { pipeline } = makePipeline();
  assert.deepEqual(pipeline.getLogs(), []);
});

// resume — 非 awaiting_review 时返回 false

test('resume: 非 awaiting_review 状态返回 false', () => {
  const { pipeline } = makePipeline();
  assert.equal(pipeline.resume(), false);
});

// cancel — 设置 cancelRequested

test('cancel: 设置 cancel 标志（通过 getStatus 无法直接观察，但不崩溃）', () => {
  const { pipeline } = makePipeline();
  pipeline.cancel();
  // cancel 不抛错即通过
});

// getDenoisePreview — 无条件列出文件

test('getDenoisePreview: 目录不存在时返回空数组', () => {
  const { pipeline } = makePipeline();
  const result = pipeline.getDenoisePreview();
  assert.deepEqual(result.files, []);
});

test('getDenoisePreview: 列出音频文件', () => {
  const { createPipeline, stagingRoot } = installStubs();
  const pipeline = createPipeline({
    voiceId: 'test-voice',
    language: 'ja',
    inputDir: tmpDir('cp-in-'),
    stepOptions: { denoise: false, slice: false, asr: false, preprocess: false, train_s1: false, train_s2: false, finalize: false, promote: false },
  });
  
  // 获取 pipeline 的实际 workDir
  const pipelineWorkDir = path.join(stagingRoot, pipeline.id);
  const denoiseDir = path.join(pipelineWorkDir, 'denoise');
  fs.mkdirSync(denoiseDir, { recursive: true });
  fs.writeFileSync(path.join(denoiseDir, 'vocal_001.wav'), 'x');
  fs.writeFileSync(path.join(denoiseDir, 'vocal_002.flac'), 'x');
  fs.writeFileSync(path.join(denoiseDir, 'not_audio.txt'), 'x');

  const result = pipeline.getDenoisePreview();
  assert.equal(result.files.length, 2);
  const names = result.files.map(f => f.name);
  assert.ok(names.includes('vocal_001.wav'));
  assert.ok(names.includes('vocal_002.flac'));
  // 非音频文件被过滤
  assert.ok(!names.includes('not_audio.txt'));
});

// resolveReviewAudioPath — 路径安全检查

test('resolveReviewAudioPath: 目录穿越返回 null', () => {
  const { pipeline } = makePipeline();
  assert.equal(pipeline.resolveReviewAudioPath('../../etc/passwd'), null);
  assert.equal(pipeline.resolveReviewAudioPath('..\\..\\windows\\system32'), null);
});

test('resolveReviewAudioPath: 非法扩展名返回 null', () => {
  const { pipeline } = makePipeline();
  assert.equal(pipeline.resolveReviewAudioPath('raw/malware.exe'), null);
  assert.equal(pipeline.resolveReviewAudioPath('raw/script.bat'), null);
});

test('resolveReviewAudioPath: 空输入返回 null', () => {
  const { pipeline } = makePipeline();
  assert.equal(pipeline.resolveReviewAudioPath(''), null);
  assert.equal(pipeline.resolveReviewAudioPath(null), null);
  assert.equal(pipeline.resolveReviewAudioPath(undefined), null);
  assert.equal(pipeline.resolveReviewAudioPath(123), null);
});

test('resolveReviewAudioPath: 合法音频文件返回绝对路径', () => {
  const { createPipeline, stagingRoot } = installStubs();
  const pipeline = createPipeline({
    voiceId: 'test-voice',
    language: 'ja',
    inputDir: tmpDir('cp-in-'),
    stepOptions: { denoise: false, slice: false, asr: false, preprocess: false, train_s1: false, train_s2: false, finalize: false, promote: false },
  });
  
  const pipelineWorkDir = path.join(stagingRoot, pipeline.id);
  const rawDir = path.join(pipelineWorkDir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'test.wav'), 'x');

  const result = pipeline.resolveReviewAudioPath('raw/test.wav');
  assert.ok(result);
  assert.ok(result.endsWith('test.wav'));
});

// saveReviewList — 参数校验

test('saveReviewList: 无校对 .list 时抛错', () => {
  const { pipeline } = makePipeline();
  assert.throws(() => pipeline.saveReviewList([]), /No reviewable \.list/);
});

test('saveReviewList: 非数组输入在无 .list 时也抛错（先检查 .list）', () => {
  const { pipeline } = makePipeline();
  // 注意：saveReviewList 先检查 _resolveReviewListPath，再检查参数类型
  // 所以无 .list 时，非数组输入也会抛 "No reviewable .list"
  assert.throws(() => pipeline.saveReviewList('not-array'), /No reviewable \.list/);
});

// 清理

// 注意：每个测试使用独立的 tmpDir，由操作系统在重启时清理。
