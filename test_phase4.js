// Phase 4 logic tests: planRebuild + generateSegments missing-slice detection.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point ASSETS_ROOT at a temp dir BEFORE requiring assetScanner.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p4assets_'));
// paths.js reads ASSETS_ROOT; override via env if supported, else monkeypatch.
process.env.ASSETS_ROOT = tmpRoot;

// assetScanner caches ASSETS_DIR from paths at load. We test planRebuild (pure)
// directly, and generateSegments by constructing dirs under the module's ASSETS_DIR.
const scanner = require('/app/workspace/src/lib/assetScanner.js');
const ASSETS = scanner.ASSETS_DIR;

console.log('ASSETS_DIR =', ASSETS);

// ---------- 1) planRebuild truth table ----------
const S = (R, S_, L, Seg, M) => ({ R, S: S_, L, Seg, M });
const plan = (st, mode) => scanner.planRebuild(st, { mode });

// Complete → noop
assert.ok(plan(S(1,1,1,1,1)).noop, 'Complete should be noop');
// Ready (no raw) → noop
assert.ok(plan(S(0,1,1,1,1)).noop, 'Ready(no raw) should be noop');
// No Segments (slices+list+models) → only generateSegments, no training
{
  const p = plan(S(1,1,1,0,1));
  assert.deepStrictEqual(p.stages, ['generateSegments'], 'No Segments → only generateSegments');
  assert.strictEqual(p.stepOptions, null, 'No Segments → no pipeline steps (no training!)');
  assert.ok(!p.requires_confirmation, 'No Segments → no confirmation');
}
// No Segments, list missing → ASR regenerates segments (NO standalone generateSegments).
// finalize/promote forced on so the result lands in assets/<id>.
{
  const p = plan(S(1,1,0,0,1));
  assert.deepStrictEqual(p.stages, ['asr'], 'list missing → just ASR (asr makes segments)');
  assert.strictEqual(p.needs_segments, false, 'asr produces segments, no standalone step');
  assert.deepStrictEqual(p.stepOptions, { denoise:false, slice:false, slicePassthrough:false, asr:true, preprocess:false, train_s1:false, train_s2:false, finalize:true, promote:true });
}
// Missing models, safe mode → NOT scheduled, surfaced as Missing Models (not Complete)
{
  const p = plan(S(1,1,1,1,0), 'safe');
  assert.ok(!p.stages, 'safe mode must not schedule any stages');
  assert.ok(!p.noop, 'safe mode missing models must NOT report no-op/Complete');
  assert.strictEqual(p.health, 'Missing Models');
  assert.strictEqual(p.requires_confirmation, true);
  assert.strictEqual(p.suggested_mode, 'full');
  assert.ok(p.warnings.some(w => /not scheduled/i.test(w)), 'safe mode warns');
}
// Missing models, full mode, slices present → train WITHOUT re-slicing.
{
  const p = plan(S(1,1,1,1,0), 'full');
  assert.deepStrictEqual(p.stages, ['preprocess','train_s1','train_s2'], 'have slices → no re-slice; both models retrained; finalize/promote forced via stepOptions');
  assert.ok(p.requires_confirmation, 'train requires confirmation');
  assert.strictEqual(p.stepOptions.train_s1, true);
  assert.strictEqual(p.stepOptions.train_s2, true);
  assert.strictEqual(p.stepOptions.slice, false, 'never re-slice when slices exist');
  assert.strictEqual(p.stepOptions.finalize, true);
  assert.strictEqual(p.stepOptions.promote, true);
}
// Missing models + missing segments, full → segments before train (cost order)
{
  const p = plan(S(1,1,1,0,0), 'full');
  assert.deepStrictEqual(p.stages, ['generateSegments','preprocess','train_s1','train_s2']);
  assert.strictEqual(p.stages.indexOf('generateSegments') < p.stages.indexOf('train_s1'), true, 'segments before train');
  assert.strictEqual(p.needs_segments, true, 'segments generated inline as train input');
}
// Only raw, full → real slice (training wants clean clips) + asr + train. No standalone segments.
{
  const p = plan(S(1,0,0,0,0), 'full');
  assert.deepStrictEqual(p.stages, ['slice','asr','preprocess','train_s1','train_s2']);
  assert.strictEqual(p.slice_mode, 'slice', 'training path uses REAL slicing');
  assert.strictEqual(p.stepOptions.slicePassthrough, false);
}
// No Refs (no raw, no slices) → error
{
  const p = plan(S(0,0,0,0,1));
  assert.ok(p.error && /re-import/i.test(p.error), 'No Refs → error');
  assert.strictEqual(p.health, 'No Refs');
}
// emergency mode → pretrained base placeholder
{
  const p = plan(S(1,1,1,1,0), 'emergency');
  assert.ok(p.uses_pretrained_base, 'emergency → uses_pretrained_base');
}

// ---- NEW: raw + models, no slices/list/segments (the LaPlama case) ----
// Default (safe): shortest path = passthrough (raw verbatim) + ASR, NO retrain.
{
  const p = plan(S(1,0,0,0,1), 'safe');
  assert.deepStrictEqual(p.stages, ['slice','asr'], 'R·M → passthrough slice + asr, no train');
  assert.strictEqual(p.slice_mode, 'passthrough', 'default does NOT re-slice; raw used as refs');
  assert.strictEqual(p.stepOptions.slicePassthrough, true);
  assert.strictEqual(p.stepOptions.train_s1, false, 'models exist → never retrain S1');
  assert.strictEqual(p.stepOptions.train_s2, false, 'models exist → never retrain S2');
  assert.strictEqual(p.requires_confirmation, false, 'no training → no confirmation');
  assert.ok(p.warnings.some(w => /verbatim/i.test(w)), 'warns raw used verbatim');
}
// Same state, caller opts into re-slicing → REAL slice, still no retrain.
{
  const p = plan(S(1,0,0,0,1), 'safe');
  const p2 = plan(S(1,0,0,0,1), 'safe'); // sanity: pure function
  assert.deepStrictEqual(p.stages, p2.stages);
  const pr = scanner.planRebuild(S(1,0,0,0,1), { mode: 'safe', reslice: true });
  assert.strictEqual(pr.slice_mode, 'slice', 'reslice opt → real slicing');
  assert.strictEqual(pr.stepOptions.slicePassthrough, false);
  assert.strictEqual(pr.stepOptions.train_s1, false, 'reslice does not imply retrain');
  assert.strictEqual(pr.stepOptions.train_s2, false, 'reslice does not imply retrain');
}
// Slices deleted but stale list survived (models present): re-slicing forces re-ASR
// so the new clips and list stay consistent — never reuse a stale list.
{
  const p = plan(S(1,0,1,0,1), 'safe');
  assert.deepStrictEqual(p.stages, ['slice','asr'], 'rebuilt slices ⇒ force re-ASR (stale list discarded)');
  assert.strictEqual(p.needs_segments, false);
}
// ---- NEW: skipAsr (reference-text-free) — user opts out of transcription ----
// R·M, no slices/list/segments + skipAsr → passthrough slice only, NO asr, NO segments.
{
  const p = scanner.planRebuild(S(1,0,0,0,1), { mode: 'safe', skipAsr: true });
  assert.deepStrictEqual(p.stages, ['slice'], 'skipAsr → passthrough slice only (no asr)');
  assert.strictEqual(p.stepOptions.asr, false, 'asr disabled');
  assert.strictEqual(p.stepOptions.slicePassthrough, true);
  assert.strictEqual(p.needs_segments, false, 'no transcript ⇒ no segments');
  assert.ok(p.warnings.some(w => /reference-text-free/i.test(w)), 'warns reference-text-free');
}
// skipAsr must be IGNORED when training (full mode) — training needs a transcript.
{
  const p = scanner.planRebuild(S(1,0,0,0,0), { mode: 'full', skipAsr: true });
  assert.ok(p.stages.includes('asr'), 'training forces ASR even with skipAsr');
  assert.strictEqual(p.stepOptions.asr, true);
  assert.strictEqual(p.stepOptions.train_s1, true);
  assert.strictEqual(p.stepOptions.train_s2, true);
}
// reslice + skipAsr → real slice, no asr (user wants clips without text).
{
  const p = scanner.planRebuild(S(1,0,0,0,1), { mode: 'safe', reslice: true, skipAsr: true });
  assert.deepStrictEqual(p.stages, ['slice'], 'reslice+skipAsr → real slice only');
  assert.strictEqual(p.slice_mode, 'slice');
  assert.strictEqual(p.stepOptions.asr, false);
}
// ---- NEW: independent S1/S2 retrain (Mg/Ms split) ----
// state with explicit per-model flags: SM(R,S,L,Seg,Mg,Ms)
const SM = (R, S_, L, Seg, Mg, Ms) => ({ R, S: S_, L, Seg, M: Mg && Ms, Mg, Ms });
// Only GPT (S1) missing → auto retrain S1 only, reuse existing slices/ASR.
{
  const p = scanner.planRebuild(SM(1,1,1,1,0,1), { mode: 'full' });
  assert.deepStrictEqual(p.stages, ['preprocess','train_s1'], 'missing GPT → S1 only');
  assert.strictEqual(p.stepOptions.train_s1, true);
  assert.strictEqual(p.stepOptions.train_s2, false, 'existing SoVITS not retrained');
}
// Only SoVITS (S2) missing → auto retrain S2 only.
{
  const p = scanner.planRebuild(SM(1,1,1,1,1,0), { mode: 'full' });
  assert.deepStrictEqual(p.stages, ['preprocess','train_s2'], 'missing SoVITS → S2 only');
  assert.strictEqual(p.stepOptions.train_s1, false, 'existing GPT not retrained');
  assert.strictEqual(p.stepOptions.train_s2, true);
}
// Explicit override: both models present, caller forces S1 retrain only.
{
  const p = scanner.planRebuild(SM(1,1,1,1,1,1), { trainS1: true, trainS2: false });
  assert.deepStrictEqual(p.stages, ['preprocess','train_s1'], 'explicit S1 retrain over existing');
  assert.strictEqual(p.stepOptions.train_s2, false);
  assert.ok(p.requires_confirmation, 'training requires confirmation');
}
// Explicit: models missing but user deselects both → warns, no training scheduled.
{
  const p = scanner.planRebuild(SM(1,1,1,1,0,0), { trainS1: false, trainS2: false });
  assert.ok(!p.stages || (!p.stages.includes('train_s1') && !p.stages.includes('train_s2')), 'no training stages');
  assert.ok(p.warnings.some(w => /still missing|incomplete/i.test(w)), 'warns models still missing');
}
console.log('PASS: independent S1/S2 retrain');

console.log('PASS: planRebuild truth table');

// ---------- 2) generateSegments missing-slice detection (Bug C) ----------
function writeList(voiceDir, names) {
  const asrDir = path.join(voiceDir, 'asr_opt');
  fs.mkdirSync(asrDir, { recursive: true });
  // slicer_opt.list format: <path>|<speaker>|<lang>|<text>
  const lines = names.map(n => `${path.join(voiceDir,'slicer_opt',n)}|spk|JA|テスト ${n}`);
  fs.writeFileSync(path.join(asrDir, 'slicer_opt.list'), lines.join('\n'), 'utf-8');
}
function makeWav(p) {
  // Minimal 44-byte WAV header so getWavDuration doesn't crash.
  const buf = Buffer.alloc(44);
  buf.write('RIFF',0); buf.writeUInt32LE(36,4); buf.write('WAVE',8);
  buf.write('fmt ',12); buf.writeUInt32LE(16,16); buf.writeUInt16LE(1,20);
  buf.writeUInt16LE(1,22); buf.writeUInt32LE(16000,24); buf.writeUInt32LE(32000,28);
  buf.writeUInt16LE(2,32); buf.writeUInt16LE(16,34); buf.write('data',36); buf.writeUInt32LE(0,40);
  fs.writeFileSync(p, buf);
}

// Case A: list + slices present → matched
{
  const vid = 'voiceA';
  const vdir = path.join(ASSETS, vid);
  const sdir = path.join(vdir, 'slicer_opt');
  fs.mkdirSync(sdir, { recursive: true });
  ['a.wav','b.wav'].forEach(n => makeWav(path.join(sdir, n)));
  writeList(vdir, ['a.wav','b.wav']);
  const r = scanner.generateSegments(vid);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.matched, 2);
  assert.strictEqual(r.missing, 0);
}
// Case B: list present but slices DELETED → ok:false, no silent empty write
{
  const vid = 'voiceB';
  const vdir = path.join(ASSETS, vid);
  fs.mkdirSync(path.join(vdir,'slicer_opt'), { recursive: true }); // empty dir
  writeList(vdir, ['x.wav','y.wav']);
  const r = scanner.generateSegments(vid);
  assert.strictEqual(r.ok, false, 'deleted slices → ok:false');
  assert.ok(/slice/i.test(r.error), 'error mentions slices');
  assert.strictEqual(r.matched, 0);
  assert.strictEqual(r.total, 2);
}
// Case C: list present, slices partially missing → matched < total, missing>0
{
  const vid = 'voiceC';
  const vdir = path.join(ASSETS, vid);
  const sdir = path.join(vdir, 'slicer_opt');
  fs.mkdirSync(sdir, { recursive: true });
  makeWav(path.join(sdir, 'p.wav')); // only 1 of 2
  writeList(vdir, ['p.wav','q.wav']);
  const r = scanner.generateSegments(vid);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.missing, 1);
}
console.log('PASS: generateSegments missing-slice detection');

// ---------- 3) detectAssetState ----------
{
  const st = scanner.detectAssetState('voiceA');
  assert.strictEqual(st.S, true, 'voiceA has slices');
  assert.strictEqual(st.L, true, 'voiceA has list');
  assert.strictEqual(st.Seg, true, 'voiceA has matched segments');
  assert.strictEqual(st.M, false, 'voiceA has no models');
  assert.strictEqual(st.Mg, false, 'voiceA has no GPT weights');
  assert.strictEqual(st.Ms, false, 'voiceA has no SoVITS weights');
}
console.log('PASS: detectAssetState');

// ---------- 4) finalize carryForward: a no-retrain rebuild must PRESERVE models ----------
// This is the safety-critical invariant: promote does a whole-dir replace, so if
// finalize doesn't carry existing models into _publish they would be wiped when we
// only re-slice / re-ASR. We run finalize.run() directly (no python/GPU needed).
(async () => {
  const finalize = require('/app/workspace/src/lib/training/steps/finalize.js');
  const vid = 'voiceFin';
  const assetDir = path.join(ASSETS, vid);          // existing live asset (ctx.publishDir)
  const workDir = path.join(tmpRoot, 'work_' + vid); // pipeline staging

  // Existing asset: models + raw already there, no slices/list (they were deleted).
  fs.mkdirSync(path.join(assetDir, 'gpt_checkpoints'), { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'gpt_checkpoints', `${vid}-e8.ckpt`), 'CKPT');
  fs.mkdirSync(path.join(assetDir, 'sovits_models'), { recursive: true });
  fs.writeFileSync(path.join(assetDir, 'sovits_models', `${vid}.pth`), 'PTH');
  fs.mkdirSync(path.join(assetDir, 'raw'), { recursive: true });
  makeWav(path.join(assetDir, 'raw', 'r1.wav'));

  // Pipeline produced fresh slices + list in workDir (passthrough + asr), NO models.
  fs.mkdirSync(path.join(workDir, 'slicer_opt'), { recursive: true });
  makeWav(path.join(workDir, 'slicer_opt', 'r1.wav'));
  fs.mkdirSync(path.join(workDir, 'asr_output'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'asr_output', 'out.list'),
    `${path.join(workDir,'slicer_opt','r1.wav')}|${vid}|JA|テスト r1`);
  fs.writeFileSync(path.join(workDir, 'segments.json'), JSON.stringify({
    voice: vid, total: 1, matched: 1,
    segments: [{ scene: 'r1', index: 0, text: 'テスト r1', audio_filename: 'r1.wav',
      audio_path: path.join(workDir,'slicer_opt','r1.wav'), matched: true }],
  }));

  const ctx = {
    voiceId: vid, language: 'ja',
    inputDir: path.join(assetDir, 'raw'),  // raw source (passthrough rebuild)
    workDir, publishDir: assetDir,         // ctx.publishDir = the live asset
    stepOptions: { slice: true, slicePassthrough: true, asr: true, train: false },
  };
  const noop = () => {};
  await finalize.run(ctx, noop);

  const pub = path.join(workDir, '_publish');
  assert.ok(fs.existsSync(path.join(pub, 'slicer_opt', 'r1.wav')), 'fresh slices published');
  assert.ok(fs.existsSync(path.join(pub, 'asr_opt', 'slicer_opt.list')), 'fresh list published');
  // The whole point: existing models survive a no-retrain rebuild.
  assert.ok(fs.existsSync(path.join(pub, 'gpt_checkpoints', `${vid}-e8.ckpt`)), 'GPT model carried forward');
  assert.ok(fs.existsSync(path.join(pub, 'sovits_models', `${vid}.pth`)), 'SoVITS model carried forward');
  assert.ok(fs.existsSync(path.join(pub, 'meta.json')), 'meta.json generated');
  console.log('PASS: finalize carryForward (models preserved on no-retrain rebuild)');

  // ---------- 5) sanitizeCustomParams: shared whitelist (train + rebuild) ----------
  // Extract the function from server.js via brace matching and eval it in isolation,
  // so both /api/train/start and /api/assets/:id/rebuild are proven to keep every
  // exposed parameter and to reject dirty/out-of-range values.
  {
    const srv = fs.readFileSync('/app/workspace/src/server.js', 'utf8');
    const start = srv.indexOf('function sanitizeCustomParams');
    assert.ok(start >= 0, 'sanitizeCustomParams present in server.js');
    let bi = srv.indexOf('{', start), depth = 0, end = -1;
    for (; bi < srv.length; bi++) {
      if (srv[bi] === '{') depth++;
      else if (srv[bi] === '}') { depth--; if (depth === 0) { end = bi + 1; break; } }
    }
    // eslint-disable-next-line no-eval
    const sanitize = eval('(' + srv.slice(start, end).replace('function sanitizeCustomParams', 'function') + ')');

    const full = {
      training: {
        gpt_epochs: 12, sovits_epochs: 9, batch_size: 'auto', learning_rate: 'default',
        seed: 1234, save_every_n_epoch: 4, precision: '16-mixed', gradient_clip: 1.0,
        lr: 0.02, lr_init: 0.00001, lr_end: 0.0001, warmup_steps: 2000, decay_steps: 40000,
        max_sec: 54, num_workers: 4, max_eval_sample: 8,
        s2_seed: 1234, log_interval: 100, eval_interval: 777, fp16_run: false,
        lr_decay: 0.999875, segment_size: 20480, c_mel: 45, c_kl: 1.0,
        text_low_lr_rate: 0.4, grad_ckpt: true,
      },
      steps: {
        slice: { params: { min_duration_sec: 4, max_duration_sec: 22, silence_threshold_db: -38, min_silence_sec: 0.7 } },
        asr: { params: { engine: 'faster-whisper', model_size: 'large-v3', precision: 'int8' } },
      },
    };
    const out = sanitize(full);
    for (const k of Object.keys(full.training)) assert.ok(k in out.training, `training.${k} preserved`);
    for (const k of Object.keys(full.steps.slice.params)) assert.ok(k in out.steps.slice.params, `slice.${k} preserved`);
    for (const k of Object.keys(full.steps.asr.params)) assert.ok(k in out.steps.asr.params, `asr.${k} preserved`);
    assert.strictEqual(out.training.eval_interval, 777);
    assert.strictEqual(out.training.fp16_run, false);
    assert.strictEqual(out.training.grad_ckpt, true);
    assert.strictEqual(out.steps.asr.params.model_size, 'large-v3');

    const dirty = sanitize({
      training: { gpt_epochs: 9999, batch_size: 'rm -rf', precision: 'evil', seed: -5, c_mel: 'x' },
      steps: { asr: { params: { model_size: '; drop', precision: 'float128', engine: 'hax' } } },
    });
    assert.strictEqual(Object.keys(dirty.training).length, 0, 'dirty training fields rejected');
    assert.strictEqual(Object.keys(dirty.steps.asr.params).length, 0, 'dirty asr fields rejected');
    console.log('PASS: sanitizeCustomParams whitelist (train + rebuild parity)');
  }

  // cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nALL PHASE 4 TESTS PASSED');
})().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
