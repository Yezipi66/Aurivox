'use strict'
// 入口推荐不把「不是合成入口」的文件推到第一位。
//   上游把训练、数据准备、模型导出、语音识别与分离、网页界面、服务端与客户端也写成
//   带命令行的脚本，它们同样声明参数，README 里也常写它们的用法。这些文件被推荐成
//   合成入口时，第 5 步一定跑不起来，而报错指向 Python，看不出是入口选错了。

const { test } = require('node:test')
const assert = require('node:assert')

const { pickEntry, isAuxEntryFile } = require('../core/entryPick')

function flag (file, name) {
  return { source: 'cli', source_file: file, name, group: '(root)', style: 'value' }
}

// 一个文件收文本、收输出，是最小可用的合成入口形状。
function entryLike (file) {
  return [flag(file, 'text'), flag(file, 'output_path')]
}

test('训练、数据准备、导出、识别与分离的脚本不算入口', () => {
  const aux = [
    'train_second.py', 'finetune_lora.py', 'prepare_data.py', 'preprocess_audio.py',
    'export_onnx.py', 'convert_checkpoint.py', 'download_models.py', 'funasr_asr.py',
    'uvr5_separate.py', 'denoise.py', 'slice_audio.py', 'evaluate.py',
  ]
  for (const f of aux) assert.strictEqual(isAuxEntryFile(f), true, `${f} 不是合成入口`)
})

test('网页界面、服务端与客户端不算入口', () => {
  const aux = ['webui.py', 'app.py', 'gradio_app.py', 'launch.py', 'demo.py',
    'server.py', 'api_v2.py', 'client_http.py', 'grpc_client.py']
  for (const f of aux) assert.strictEqual(isAuxEntryFile(f), true, `${f} 不是合成入口`)
})

test('带入口词的组合仍然算入口', () => {
  const keep = ['cli.py', 'infer.py', 'inference.py', 'synthesize.py', 'main.py',
    'webui_cli.py', 'tts_app.py', 'inference_cli.py', 'train_cli.py']
  for (const f of keep) assert.strictEqual(isAuxEntryFile(f), false, `${f} 仍是入口`)
})

test('部署树里的脚本不算本机入口', () => {
  assert.strictEqual(isAuxEntryFile('runtime/triton/streaming_inference.py'), true)
  assert.strictEqual(isAuxEntryFile('deploy/serve.py'), true)
  assert.strictEqual(isAuxEntryFile('pkg/runtime_utils.py'), false, '只是名字里带 runtime 不算')
})

test('README 点名的辅助脚本不会被推荐为入口', () => {
  const params = [
    ...entryLike('pkg/inference_cli.py'),
    flag('tools/asr/funasr_asr.py', 'input_dir'),
    flag('tools/asr/funasr_asr.py', 'output_dir'),
  ]
  const got = pickEntry(params, { fromReadme: { modules: [], files: ['tools/asr/funasr_asr.py'] } })
  assert.strictEqual(got.file, 'pkg/inference_cli.py', '作者写过的辅助脚本不该顶掉合成入口')
  assert.strictEqual(got.source, 'score')
})

test('只剩辅助脚本时不给推荐', () => {
  const params = [
    flag('webui.py', 'text'),
    flag('webui.py', 'output_path'),
    flag('train_second.py', 'config'),
  ]
  const got = pickEntry(params, { fromReadme: { modules: [], files: ['webui.py'] } })
  assert.strictEqual(got.file, null)
  assert.strictEqual(got.confidence, 'none')
})

test('打包声明点到辅助脚本时同样跳过', () => {
  const params = [
    ...entryLike('pkg/infer.py'),
    flag('pkg/export_onnx.py', 'text'),
    flag('pkg/export_onnx.py', 'output_path'),
  ]
  const got = pickEntry(params, { fromEntryPoints: { modules: ['pkg.export_onnx'], files: [] } })
  assert.strictEqual(got.file, 'pkg/infer.py')
})

test('辅助脚本不进候选表，避免界面把三个位置全给它们', () => {
  const params = [
    ...entryLike('pkg/infer.py'),
    ...entryLike('webui.py'),
    ...entryLike('train_second.py'),
  ]
  const got = pickEntry(params)
  assert.deepStrictEqual(got.candidates.map((c) => c.file), ['pkg/infer.py'])
})

test('声明的入口之外，打分出来的实现文件也要留在候选里', () => {
  // 打包声明里常是包装脚本（要 -c 调用），真正的 argparse 实现在同仓库另一个文件。
  //   候选池只留声明那几条时，界面下拉里就只剩跑不起来的入口。
  const params = [
    flag('melo/main.py', 'speaker'),
    flag('melo/infer.py', 'text'),
    flag('melo/infer.py', 'output_dir'),
    flag('melo/infer.py', 'ckpt_path'),
    flag('melo/infer.py', 'language'),
  ]
  const got = pickEntry(params, { fromEntryPoints: { modules: ['melo.main'], files: [] } })
  assert.strictEqual(got.file, 'melo/main.py', '默认仍按作者的声明')
  assert.ok(got.candidates.some((c) => c.file === 'melo/infer.py'),
    '打分出来的实现文件必须留在候选里，否则下拉里没有能跑的入口')
})

// 新增四台仓库暴露的写法：演示目录、微调目录、*_demo.py、ASR 转写与音素化脚本。
// 它们被推荐成入口时第 5 步一定失败，而报错指向 Python，看不出是入口选错。
test('演示、微调、转写与数据准备脚本也不算入口', () => {
  const aux = ['tts_demo.py', 'demo/realtime_model_inference_from_file.py',
    'finetune_codes/model.py', 'finetune_codes/demo_data/prepare.py',
    'funasr_detach/models/whisper/utils/transcribe.py',
    'data/phonemize_encodec_encode_hf.py',
    'finetuning-asr/inference_lora.py']
  for (const f of aux) assert.strictEqual(isAuxEntryFile(f), true, `${f} 不是合成入口`)
})

test('入口词覆盖规则没有被上一条带偏', () => {
  const keep = ['tts_app.py', 'train_cli.py', 'webui_cli.py', 'examples/cmd/run.py',
    'tts_inference.py', 'infer.py']
  for (const f of keep) assert.strictEqual(isAuxEntryFile(f), false, `${f} 仍是入口`)
})
