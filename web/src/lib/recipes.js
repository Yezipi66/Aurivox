export function recipePath(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value.base === 'asset' && value.path) return `assets/${String(value.path).replace(/^assets\//, '')}`
  if (value.base === 'external' && value.path) return value.path
  return ''
}
export function recipeToGenerateParams(recipe, currentText = '') {
  const p = recipe?.params || {}
  return { voice:recipe?.role||'', text:currentText, ref_audio:recipePath(recipe?.reference_audio), reference_text:recipe?.reference_text||'', text_lang:recipe?.language||'', gpt_model:recipePath(recipe?.gpt_ckpt), sovits_model:recipePath(recipe?.sovits_pth), temperature:p.temperature, top_k:p.top_k, top_p:p.top_p, speed_factor:p.speed, repetition_penalty:p.repetition_penalty, text_split_method:p.text_split_method, seed:p.seed, sample_steps:p.sample_steps, if_sr:p.if_sr, batch_size:p.batch_size, batch_threshold:p.batch_threshold, split_bucket:p.split_bucket, fragment_interval:p.fragment_interval, parallel_infer:p.parallel_infer, aux_ref_audio_paths:(p.aux_ref_audio_paths||[]).map(recipePath).filter(Boolean), pron_overrides:p.pron_overrides||{}, lang_overrides:p.lang_overrides||{}, han_readings:p.han_readings||{} }
}
