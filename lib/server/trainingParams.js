// sanitizeCustomParams — whitelist validation for training parameters.
// Extracted from server.js (P0 refactor).

const _uvr5Models = require("../../pipeline/uvr5/uvr5_models");

function sanitizeCustomParams(custom) {
  if (!custom || typeof custom !== 'object') return {};
  const safe = {};

  const num = (dst, key, v, min, max) => {
    if (v == null) return;
    const n = Number(v);
    if (Number.isFinite(n) && n >= min && n <= max) dst[key] = n;
  };
  const intNum = (dst, key, v, min, max) => {
    if (v == null) return;
    const n = Math.round(Number(v));
    if (Number.isFinite(n) && n >= min && n <= max) dst[key] = n;
  };
  const bool = (dst, key, v) => { if (typeof v === 'boolean') dst[key] = v; };
  const oneOf = (dst, key, v, allowed) => { if (allowed.includes(v)) dst[key] = v; };
  const word = (dst, key, v, keyword, min, max) => {
    if (v == null) return;
    if (v === keyword) { dst[key] = keyword; return; }
    const n = Number(v);
    if (Number.isFinite(n) && n >= min && n <= max) dst[key] = n;
  };

  if (custom.training) {
    const t = custom.training;
    const s = (safe.training = {});
    intNum(s, 'gpt_epochs', t.gpt_epochs, 1, 100);
    intNum(s, 'sovits_epochs', t.sovits_epochs, 1, 100);
    word(s, 'batch_size', t.batch_size, 'auto', 1, 16);
    word(s, 'learning_rate', t.learning_rate, 'default', 1e-7, 1);
    oneOf(s, 'version', t.version, ['v2', 'v2Pro', 'v2ProPlus']);
    if (Array.isArray(t.versions)) {
      const _allowedV = ['v2', 'v2Pro', 'v2ProPlus'];
      const _vs = [];
      for (const v of t.versions) if (_allowedV.includes(v) && !_vs.includes(v)) _vs.push(v);
      if (_vs.length) s.versions = _vs;
    }
    intNum(s, 'seed', t.seed, 0, 999999);
    intNum(s, 'save_every_n_epoch', t.save_every_n_epoch, 1, 50);
    intNum(s, 's1_save_every_n_epoch', t.s1_save_every_n_epoch, 1, 50);
    intNum(s, 's2_save_every_n_epoch', t.s2_save_every_n_epoch, 1, 50);
    oneOf(s, 'precision', t.precision, ['16-mixed', '16-true', 'bf16-mixed', 'bf16-true', '32-true', '32']);
    num(s, 'gradient_clip', t.gradient_clip, 0.1, 10);
    num(s, 'lr', t.lr, 1e-7, 1);
    num(s, 'lr_init', t.lr_init, 1e-7, 0.1);
    num(s, 'lr_end', t.lr_end, 1e-7, 0.1);
    intNum(s, 'warmup_steps', t.warmup_steps, 0, 100000);
    intNum(s, 'decay_steps', t.decay_steps, 1, 200000);
    num(s, 'max_sec', t.max_sec, 1, 300);
    intNum(s, 'num_workers', t.num_workers, 0, 16);
    intNum(s, 'max_eval_sample', t.max_eval_sample, 1, 100);
    intNum(s, 's2_seed', t.s2_seed, 0, 999999);
    intNum(s, 'log_interval', t.log_interval, 1, 10000);
    intNum(s, 'eval_interval', t.eval_interval, 1, 10000);
    bool(s, 'fp16_run', t.fp16_run);
    num(s, 'lr_decay', t.lr_decay, 0.9, 1);
    intNum(s, 'segment_size', t.segment_size, 1024, 65536);
    num(s, 'c_mel', t.c_mel, 1, 100);
    num(s, 'c_kl', t.c_kl, 0.1, 10);
    num(s, 'text_low_lr_rate', t.text_low_lr_rate, 0.01, 1);
    bool(s, 'grad_ckpt', t.grad_ckpt);
  }
  if (custom.steps) {
    safe.steps = {};
    if (custom.steps.slice && custom.steps.slice.params) {
      const p = custom.steps.slice.params;
      const sp = (safe.steps.slice = { params: {} }).params;
      num(sp, 'min_duration_sec', p.min_duration_sec, 1, 30);
      num(sp, 'max_duration_sec', p.max_duration_sec, 1, 60);
      num(sp, 'silence_threshold_db', p.silence_threshold_db, -60, 0);
      num(sp, 'min_silence_sec', p.min_silence_sec, 0.1, 5);
    }
    if (custom.steps.asr && custom.steps.asr.params) {
      const p = custom.steps.asr.params;
      const ap = (safe.steps.asr = { params: {} }).params;
      oneOf(ap, 'engine', p.engine, ['auto', 'funasr', 'faster-whisper']);
      oneOf(ap, 'model_size', p.model_size,
        ['large-v3-turbo', 'large-v3', 'large', 'medium', 'small', 'tiny', 'distil-large-v3']);
      oneOf(ap, 'precision', p.precision, ['float16', 'float32', 'int8']);
      bool(ap, 'force_simplified_chinese', p.force_simplified_chinese);
    }
    if (custom.steps.denoise && custom.steps.denoise.params) {
      safe.steps.denoise = { params: {} };
      const dp = custom.steps.denoise.params;
      const pipeline = _uvr5Models.normalizePipeline(
        Array.isArray(dp.pipeline) ? dp.pipeline : dp
      );
      if (pipeline.length) safe.steps.denoise.params.pipeline = pipeline;
    }
  }
  return safe;
}

module.exports = { sanitizeCustomParams };
