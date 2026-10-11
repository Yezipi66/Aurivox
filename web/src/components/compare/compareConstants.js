import { TARGET_LANG_OPTIONS } from '../../lib/format'

// Compare Refs target-language options: the plain per-segment "auto" is dropped
// here (this page is decoupled from the Generate voice — no per-voice auto-detect),
// but the multilingual "auto_zh_ja_yue" is kept for zh+ja shared-Han comparison.
export const CMP_LANG_OPTIONS = TARGET_LANG_OPTIONS.filter(o => o.value !== 'auto')

// Reserved id of the built-in Base model (zero-shot pretrained-weights voice).
export const BASE_VOICE_ID = '__base__'
