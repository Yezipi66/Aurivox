// 步骤顺序与每步在 workDir 里的产物。

// ── Resume / 断点恢复支持 ──────────────────────────────────────────────────
// 步骤顺序（与 stepDefs 一致，用于级联清理与"从第 X 步往下"计算）。
const STEP_ORDER = ['denoise', 'slice', 'asr', 'preprocess', 'train_s1', 'train_s2', 'finalize', 'promote'];

// 每步在 workDir 里的产物（相对路径），用于改参重跑时精准清理该步及下游产物，
// 让被跳过的上游产物原样复用、被重跑的步用新参数从头产出。绝不列上游产物。
const STEP_OUTPUTS = {
  denoise:    ['denoise', 'raw_b4_extraction'],
  slice:      ['slicer_opt'],
  asr:        ['asr_output', 'segments.json'],
  preprocess: ['2-name2text.txt', '2-name2text-0.txt', '2-name2text-1.txt',
               '3-bert', '4-cnhubert', '5-wav32k',
               '6-name2semantic-0.tsv', '6-name2semantic-1.tsv', '7-sv_cn'],
  train_s1:   ['logs_s1'],
  train_s2:   ['logs_s2'],   // 多版本 logs_s2_<version> 由下方 glob 兜底
  finalize:   ['_publish'],
  promote:    [],
};

module.exports = { STEP_ORDER, STEP_OUTPUTS };
