'use strict'
// 生成测试用的夹具引擎名片。
//
// 为什么用脚本生成而不是手写两个 JSON：
//   夹具的参数名必须恰好覆盖 C11 豁免清单登记的那批键
//   （lib/engines/c11ParamTable.node.test.js 的 EXEMPT），
//   否则那条守卫会判「豁免已腐烂」。
//   键名一变就要改两个 JSON，脚本改一处就够。
//
// 约束（改参数名时必须一起看）：
//   ① 夹具的参数名不许出现在 lib/ 里，除非那个键在 EXEMPT 里登记了。
//   否则 C11 守卫会报「lib/ 写死了引擎参数名」，那是真判据，不是误报。
//   ② 两台的 ready_endpoint 必须不同（"/health" 与 "/ready"）：
//      「两台引擎的探活地址要不同」是 launchPlan 那条守卫的判据。
//   ③ 两台的 max_chars 必须不同（60 与 120）。
//   ④ 一台要参考音频、一台不要：covers requires_reference_audio 这类分支。
//   ⑤ 只用新写法 parameters[]：旧写法 param_keys/params/payload_keys
//      与它并存会被 registry 拒绝（lib/engines/parameterDeclaration.js 的 deriveParameterViews）。
//
// 跑法：node tools/engine-wizard/test/makeFixtureEngines.cjs

const fs = require('node:fs')
const path = require('node:path')

const OUT_DIR = path.join(__dirname, 'fixtures', 'engines')

/**
 * 参数名清单。
 * 每个键带 phase（load/call）与 tier（common/advanced）：
 *   phase=load 的键用来验「load 参数一律 advanced」那条先验；
 *   tier=common 的键要够多，否则「call 参数里 advanced 多于 common」那条不成立。
 */
const ALPHA_PARAMS = [
  // 平台概念名与资产字段：EXEMPT 里登记过，必须出现在夹具里
  ['text_lang', 'call', 'common', 'string'],
  ['reference_text', 'call', 'advanced', 'string'],
  ['aux_ref_audio_paths', 'call', 'advanced', 'file'],
  ['lang', 'call', 'advanced', 'string'],
  // 训练侧配置：EXEMPT 里登记过
  ['batch_size', 'call', 'advanced', 'integer'],
  // 历史事实清单：EXEMPT 里登记过
  ['batch_threshold', 'call', 'advanced', 'integer'],
  ['fragment_interval', 'call', 'advanced', 'number'],
  ['top_k', 'call', 'advanced', 'integer'],
  ['top_p', 'call', 'advanced', 'number'],
  ['temperature', 'call', 'advanced', 'number'],
  ['if_sr', 'call', 'advanced', 'boolean'],
  ['text_split_method', 'call', 'advanced', 'string'],
  ['repetition_penalty', 'call', 'advanced', 'number'],
  ['sample_steps', 'call', 'advanced', 'integer'],
  ['split_bucket', 'call', 'advanced', 'boolean'],
  ['parallel_infer', 'call', 'advanced', 'boolean'],
  ['pron_overrides', 'call', 'advanced', 'text'],
  // 名字启发要认得出的那批（tierreview 那条守卫拿它们当基线）
  ['emo_alpha', 'call', 'common', 'number'],
  ['interval_silence', 'call', 'common', 'number'],
  ['use_fp16', 'load', 'advanced', 'boolean'],
  ['use_random', 'call', 'advanced', 'boolean'],
  ['verbose', 'call', 'advanced', 'boolean'],
  ['use_deepspeed', 'load', 'advanced', 'boolean'],
  ['use_cuda_kernel', 'load', 'advanced', 'boolean'],
  ['use_torch_compile', 'load', 'advanced', 'boolean'],
  ['max_text_tokens_per_segment', 'load', 'advanced', 'integer'],
]

const BETA_PARAMS = [
  ['text_lang', 'call', 'common', 'string'],
  ['emo_alpha', 'call', 'common', 'number'],
  ['interval_silence', 'call', 'common', 'number'],
  ['use_deepspeed', 'load', 'advanced', 'boolean'],
  ['use_cuda_kernel', 'load', 'advanced', 'boolean'],
  ['use_accel', 'load', 'advanced', 'boolean'],
  ['use_torch_compile', 'load', 'advanced', 'boolean'],
  ['use_fp16', 'load', 'advanced', 'boolean'],
  ['use_random', 'call', 'advanced', 'boolean'],
  ['verbose', 'call', 'advanced', 'boolean'],
  ['max_text_tokens_per_segment', 'load', 'advanced', 'integer'],
  ['batch_size', 'call', 'advanced', 'integer'],
  ['batch_threshold', 'call', 'advanced', 'integer'],
  ['fragment_interval', 'call', 'advanced', 'number'],
  ['top_k', 'call', 'advanced', 'integer'],
  ['top_p', 'call', 'advanced', 'number'],
  ['temperature', 'call', 'advanced', 'number'],
  ['if_sr', 'call', 'advanced', 'boolean'],
  ['text_split_method', 'call', 'advanced', 'string'],
  ['repetition_penalty', 'call', 'advanced', 'number'],
  ['sample_steps', 'call', 'advanced', 'integer'],
  ['split_bucket', 'call', 'advanced', 'boolean'],
  ['parallel_infer', 'call', 'advanced', 'boolean'],
  ['pron_overrides', 'call', 'advanced', 'text'],
  ['reference_text', 'call', 'advanced', 'string'],
  ['aux_ref_audio_paths', 'call', 'advanced', 'file'],
  ['lang', 'call', 'advanced', 'string'],
]

/** 参数名 → 界面标签（用名字本身，中英文各一份） */
function labelOf (name) {
  return { en: name, zh: name }
}

function buildParameters (rows) {
  return rows.map(([name, phase, tier, type]) => ({
    name,
    phase,
    tier,
    type,
    label: labelOf(name),
    help: { en: `The ${name} option.`, zh: `${name} 这一项。` },
  }))
}

/**
 * 一台夹具引擎的名片。
 *
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {string} spec.readyEndpoint
 * @param {number} spec.port
 * @param {number} spec.maxChars
 * @param {boolean} spec.needsReference
 * @param {Array} spec.params
 * @param {string} spec.commit
 */
function buildManifest (spec) {
  return {
    contract_version: 2,
    id: spec.id,
    label: spec.label,
    upstream: {
      url: `https://github.com/example/${spec.id}`,
      commit: spec.commit,
      license: 'MIT',
    },
    default_base_url: `http://127.0.0.1:${spec.port}`,
    base_url_env: `${spec.id.toUpperCase().replace(/-/g, '_')}_BASE_URL`,
    timeout_ms: 300000,
    timeout_ms_source: 'estimated',
    max_chars: spec.maxChars,
    max_chars_source: 'estimated',
    capabilities: {
      requires_reference_audio: spec.needsReference,
      reference_clip_seconds: spec.needsReference ? [3, 10] : null,
      streaming: spec.needsReference,
      output_sample_rate: 32000,
      supports_finetune: false,
    },
    runtime: {
      python: `engines/${spec.id}/.venv`,
      entry: '../../lib/inference/infer_server.py',
      args: [
        '-a', '{host}',
        '-p', '{port}',
        '-c', '{root}/lib/inference/tts_infer.yaml',
      ],
      cwd: '.',
      checkpoints: `models/tts/${spec.id}`,
      ready_endpoint: spec.readyEndpoint,
      ready_timeout_ms: 180000,
      ready_timeout_ms_source: 'estimated',
      preload: false,
      verify: {
        sys_path: [`engines/${spec.id}/infer`, `engines/${spec.id}`],
        imports: [
          { module: 'TTS', class: 'TTS', methods: ['run', 'set_ref_audio'] },
        ],
      },
    },
    maps: {
      text: 'text',
      text_lang: 'text_lang',
      reference_audio: 'ref_audio_path',
      reference_text: 'prompt_text',
      seed: 'seed',
    },
    parameters: buildParameters(spec.params),
  }
}

const ENGINES = [
  {
    id: 'fixture-alpha',
    label: 'Fixture Alpha',
    readyEndpoint: '/health',
    port: 19880,
    maxChars: 60,
    needsReference: true,
    commit: '0123456789abcdef0123456789abcdef01234567',
    params: ALPHA_PARAMS,
  },
  {
    id: 'fixture-beta',
    label: 'Fixture Beta',
    readyEndpoint: '/ready',
    port: 19881,
    maxChars: 120,
    needsReference: false,
    commit: 'fedcba9876543210fedcba9876543210fedcba98',
    params: BETA_PARAMS,
  },
]

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const spec of ENGINES) {
  const dir = path.join(OUT_DIR, spec.id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'manifest.json')
  fs.writeFileSync(file, JSON.stringify(buildManifest(spec), null, 2) + '\n', 'utf8')
  console.log('wrote', path.relative(path.join(__dirname, '..', '..', '..'), file))
}
