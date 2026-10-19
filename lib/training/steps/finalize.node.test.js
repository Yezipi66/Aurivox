// finalize.node.test.js
// 最终化步骤测试：产物拷贝、meta.json 生成、多版本 SoVITS 处理。
// 通过 mock assetScanner + paths，不依赖真实 engines/ 目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FINALIZE_PATH = path.join(__dirname, 'finalize.js');
const PATHS_PATH = path.resolve(__dirname, '..', '..', 'paths');
const ASSET_SCANNER_PATH = path.resolve(__dirname, '..', '..', 'assetScanner');
const MODEL_LAYOUT_PATH = path.resolve(__dirname, '..', '..', 'assets', 'modelLayout');
const PIPELINE_IDENTITY_PATH = path.join(__dirname, '..', 'pipelineIdentity');

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function installStubs() {
  delete require.cache[require.resolve(FINALIZE_PATH)];

  // mock assetScanner
  const resolvedScanner = require.resolve(ASSET_SCANNER_PATH);
  require.cache[resolvedScanner] = {
    id: resolvedScanner,
    filename: resolvedScanner,
    loaded: true,
    exports: {
      scanVoiceDir: (voiceId, voiceDir) => ({
        id: voiceId,
        display_name: voiceId,
        mode: 'internal',
        language: 'ja',
        prompt_lang: 'ja',
        text_lang: 'ja',
        created_at: new Date().toISOString(),
        assets: {},
      }),
    },
  };

  // mock modelLayout
  const resolvedLayout = require.resolve(MODEL_LAYOUT_PATH);
  require.cache[resolvedLayout] = {
    id: resolvedLayout,
    filename: resolvedLayout,
    loaded: true,
    exports: {
      MODELS_DIR: 'models',
      slotDir: (voiceDir, engineId, slotName) =>
        path.join(voiceDir, 'models', engineId, slotName),
    },
  };

  // mock pipelineIdentity
  const resolvedIdentity = require.resolve(PIPELINE_IDENTITY_PATH);
  require.cache[resolvedIdentity] = {
    id: resolvedIdentity,
    filename: resolvedIdentity,
    loaded: true,
    exports: {
      TRAINING_ENGINE_ID: 'test-engine',
      TRAINING_SLOTS: {
        gpt: { name: 'gpt', ext: '.ckpt' },
        sovits: { name: 'sovits', ext: '.pth' },
      },
    },
  };

  return { finalize: require(FINALIZE_PATH) };
}

function makeCtx(workDir, opts = {}) {
  // finalize 内部使用 path.join(workDir, '_publish') 作为发布目录
  // 所以需要预先创建它
  const publishDir = path.join(workDir, '_publish');
  fs.mkdirSync(publishDir, { recursive: true });
  return {
    workDir,
    inputDir: opts.inputDir || tmpDir('fin-in-'),
    publishDir,
    voiceId: 'test-voice',
    language: 'ja',
    config: {
      training: {
        version: 'v2',
      },
    },
    stepOptions: opts.stepOptions || {},
    displayName: opts.displayName || null,
    refinement: opts.refinement || null,
  };
}

function createS1Checkpoint(workDir, voiceId) {
  const ckptDir = path.join(workDir, 'logs_s1', voiceId, 'ckpt');
  fs.mkdirSync(ckptDir, { recursive: true });
  fs.writeFileSync(path.join(ckptDir, `${voiceId}-e8.ckpt`), 'x');
}

function createS2Model(workDir, voiceId) {
  const s2Dir = path.join(workDir, 'logs_s2', voiceId);
  fs.mkdirSync(s2Dir, { recursive: true });
  fs.writeFileSync(path.join(s2Dir, `${voiceId}_e25_s100.pth`), 'x');
}

function createSlicerOpt(workDir) {
  const slicerDir = path.join(workDir, 'slicer_opt');
  fs.mkdirSync(slicerDir, { recursive: true });
  fs.writeFileSync(path.join(slicerDir, 'clip_001.wav'), 'x');
}

function createAsrOutput(workDir) {
  const asrDir = path.join(workDir, 'asr_output');
  fs.mkdirSync(asrDir, { recursive: true });
  fs.writeFileSync(path.join(asrDir, 'slicer_opt.list'), 'slicer_opt/clip_001.wav|test-voice|JA|テスト\n');
  fs.writeFileSync(path.join(asrDir, 'slicer_opt.conf.json'), JSON.stringify({ 'clip_001.wav': { confidence: 0.95 } }));
}

// ---------------------------------------------------------------------------
// 空 workDir → 生成 meta.json
// ---------------------------------------------------------------------------

test('run: 空 workDir 生成 meta.json', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  assert.ok(result.publishDir);
  assert.ok(fs.existsSync(path.join(result.publishDir, 'meta.json')));
  const meta = JSON.parse(fs.readFileSync(path.join(result.publishDir, 'meta.json'), 'utf-8'));
  assert.equal(meta.id, 'test-voice');
  assert.equal(meta.language, 'ja');
  assert.equal(meta.training.status, 'completed');
});

// ---------------------------------------------------------------------------
// S1 checkpoint 拷贝
// ---------------------------------------------------------------------------

test('run: S1 checkpoint 拷贝到 models/test-engine/gpt/', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  createS1Checkpoint(workDir, 'test-voice');

  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  const gptDir = path.join(result.publishDir, 'models', 'test-engine', 'gpt');
  assert.ok(fs.existsSync(gptDir));
  const files = fs.readdirSync(gptDir);
  assert.ok(files.some(f => f.endsWith('.ckpt')));
});

// ---------------------------------------------------------------------------
// S2 model 拷贝
// ---------------------------------------------------------------------------

test('run: S2 model 拷贝到 models/test-engine/sovits/', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  createS2Model(workDir, 'test-voice');

  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  const sovitsDir = path.join(result.publishDir, 'models', 'test-engine', 'sovits');
  assert.ok(fs.existsSync(sovitsDir));
  const files = fs.readdirSync(sovitsDir);
  assert.ok(files.some(f => f.endsWith('.pth')));
});

// ---------------------------------------------------------------------------
// slicer_opt 拷贝
// ---------------------------------------------------------------------------

test('run: slicer_opt/ 拷贝到 _publish/', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  createSlicerOpt(workDir);

  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  const slicerDst = path.join(result.publishDir, 'slicer_opt');
  assert.ok(fs.existsSync(slicerDst));
  assert.ok(fs.existsSync(path.join(slicerDst, 'clip_001.wav')));
});

// ---------------------------------------------------------------------------
// asr_output 拷贝
// ---------------------------------------------------------------------------

test('run: asr_output/ 拷贝到 asr_opt/', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  createAsrOutput(workDir);

  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  const asrDst = path.join(result.publishDir, 'asr_opt');
  assert.ok(fs.existsSync(asrDst));
  assert.ok(fs.existsSync(path.join(asrDst, 'slicer_opt.list')));
  assert.ok(fs.existsSync(path.join(asrDst, 'slicer_opt.conf.json')));
});

// ---------------------------------------------------------------------------
// copyRaw = false → 跳过 raw 拷贝
// ---------------------------------------------------------------------------

test('run: copyRaw=false 时跳过 raw 拷贝', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  const inputDir = tmpDir('fin-in-');
  fs.writeFileSync(path.join(inputDir, 'raw_audio.wav'), 'x');

  const ctx = makeCtx(workDir, { inputDir, stepOptions: { copyRaw: false } });
  const result = await finalize.run(ctx, () => {});

  const rawDst = path.join(result.publishDir, 'raw');
  assert.ok(!fs.existsSync(rawDst));
});

// ---------------------------------------------------------------------------
// 多版本 SoVITS 产物
// ---------------------------------------------------------------------------

test('run: 多版本 SoVITS 产物从 .s2_products.json 读取', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');

  // 创建多版本产物
  const v2Dir = path.join(workDir, 'logs_s2_v2', 'test-voice');
  const v2ProDir = path.join(workDir, 'logs_s2_v2Pro', 'test-voice');
  fs.mkdirSync(v2Dir, { recursive: true });
  fs.mkdirSync(v2ProDir, { recursive: true });
  fs.writeFileSync(path.join(v2Dir, 'test-voice_e25_s100.pth'), 'x');
  fs.writeFileSync(path.join(v2ProDir, 'test-voice_e25_s100.pth'), 'x');

  // 写入 .s2_products.json
  fs.writeFileSync(path.join(workDir, '.s2_products.json'), JSON.stringify({
    products: [
      { version: 'v2', dir: 'logs_s2_v2/test-voice' },
      { version: 'v2Pro', dir: 'logs_s2_v2Pro/test-voice' },
    ],
    primary: 'v2',
  }));

  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  const sovitsDir = path.join(result.publishDir, 'models', 'test-engine', 'sovits');
  assert.ok(fs.existsSync(sovitsDir));
  const files = fs.readdirSync(sovitsDir);
  assert.ok(files.length >= 2);
});

// ---------------------------------------------------------------------------
// displayName 写入 meta
// ---------------------------------------------------------------------------

test('run: displayName 写入 meta.json', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  const ctx = makeCtx(workDir, { displayName: 'My Voice' });
  const result = await finalize.run(ctx, () => {});

  const meta = JSON.parse(fs.readFileSync(path.join(result.publishDir, 'meta.json'), 'utf-8'));
  assert.equal(meta.display_name, 'My Voice');
});

// ---------------------------------------------------------------------------
// refinement 写入 meta
// ---------------------------------------------------------------------------

test('run: refinement 写入 meta.json', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
  const ctx = makeCtx(workDir, {
    refinement: {
      refinement_type: 's2',
      parent_voice_id: 'parent-voice',
      generation: 2,
    },
  });
  const result = await finalize.run(ctx, () => {});

  const meta = JSON.parse(fs.readFileSync(path.join(result.publishDir, 'meta.json'), 'utf-8'));
  assert.equal(meta.refinement.parent_voice_id, 'parent-voice');
  assert.equal(meta.refinement.generation, 2);
});

// ---------------------------------------------------------------------------
// segments.json 兜底拷贝
// ---------------------------------------------------------------------------

test('run: segments.json 兜底拷贝到 _publish/', async () => {
  const { finalize } = installStubs();
  const workDir = tmpDir('fin-work-');
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

  const ctx = makeCtx(workDir);
  const result = await finalize.run(ctx, () => {});

  const segDst = path.join(result.publishDir, 'segments.json');
  assert.ok(fs.existsSync(segDst));
  const copied = JSON.parse(fs.readFileSync(segDst, 'utf-8'));
  assert.equal(copied.segments[0].audio_path, 'assets/test-voice/slicer_opt/clip_001.wav');
});
