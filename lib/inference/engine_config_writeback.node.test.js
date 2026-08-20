// 引擎配置写回的守卫（r12c-fix13）
//
// 背景：lib/inference/tts_infer.yaml 是每机一份、不进 git 的运行时状态，
// 由 TTS.py 的 save_configs() 写、由 start.ps1 的 Repair-EngineConfig 校验。
// 上游 save_configs() 把 default_configs 全表倒进文件，其中 v3/v4 写死的是
// 上游布局 GPT_SoVITS/pretrained_models/ —— 本项目没有那个目录。于是：
//   热切模型 -> 死路径写回配置 -> 下次启动判 stale -> 整份重置 -> 选的模型丢
// 本文件盯住这条链的三个环节，任何一环被改回去都要响。
//
// 这些是**源码级绊线**：跑 TTS.py 需要 torch，测试环境里没有，所以这里读源码
// 文本断言。绊线的价值在于它会因为「有人把改动还原了」而失败 —— 下面每条断言
// 都对应一个具体的、发生过的故障。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// 路径一律取自 lib/paths.js（纪律 C8：项目布局只在那里定义一次）。
// 自己拼 engines/gpt-sovits/... 会被 lib/paths.node.test.js 的权威守卫拦下 ——
// 而且 engines 化改造正是要动这段布局，硬编码的测试届时会集体失准。
const { GSV_INFER_DIR, INFERENCE_DIR } = require('../paths');

const TTS_PY = path.join(GSV_INFER_DIR, 'TTS.py');
const EXAMPLE = path.join(INFERENCE_DIR, 'tts_infer.yaml.example');

const ttsSrc = fs.readFileSync(TTS_PY, 'utf8');
const exampleSrc = fs.readFileSync(EXAMPLE, 'utf8');

// 取 save_configs 的方法体（到下一个同级 def 为止）
function saveConfigsBody(src) {
  const start = src.indexOf('    def save_configs(');
  assert.notStrictEqual(start, -1, 'TTS.py 里找不到 save_configs —— 上游结构变了，本守卫需要重写');
  const rest = src.slice(start + 1);
  const next = rest.indexOf('\n    def ');
  return next === -1 ? rest : rest.slice(0, next);
}

test('save_configs 只写回文件里原有的段（否则 v3/v4 死路径每次热切模型都复活）', () => {
  const body = saveConfigsBody(ttsSrc);
  assert.ok(
    body.includes('_file_sections'),
    'save_configs 不再引用 _file_sections：它又在倒 default_configs 全表了。' +
    '后果是 v3/v4 的 GPT_SoVITS/pretrained_models/ 死路径被写回 tts_infer.yaml，' +
    '下次启动 Repair-EngineConfig 判 stale 整份重置，用户选的模型丢失');
});

test('__init__ 记录了 _file_sections（不记就等于没改）', () => {
  assert.ok(
    /self\._file_sections\s*=/.test(ttsSrc),
    'TTS.py 里没有给 self._file_sections 赋值 —— save_configs 会永远走 None 分支写全表');
});

test('save_configs 把项目根之下的绝对路径相对化（否则换机器必崩）', () => {
  const body = saveConfigsBody(ttsSrc);
  assert.ok(
    body.includes('_aurivox_relativise_paths'),
    'save_configs 不再相对化路径：本机盘符会被钉进 tts_infer.yaml，' +
    '安装目录一搬（或换台机器）引擎就加载失败');
  assert.ok(
    ttsSrc.includes('def _aurivox_relativise_paths('),
    '调用了 _aurivox_relativise_paths 但函数本身不在 TTS.py 里 —— 会 NameError');
});

test('save_configs 写文件用显式 utf-8（_load_configs 是按 utf-8 读的）', () => {
  const body = saveConfigsBody(ttsSrc);
  assert.ok(
    /open\(configs_path,\s*"w",\s*encoding="utf-8"\)/.test(body),
    '写配置没有显式 utf-8：中文 Windows 上落到 GBK，而读侧是 utf-8');
});

// ---- 正对照：证明上面几条不是「随便断言什么都过」------------------------
// 这条守的是相反的方向：有人"顺手清理"把 v3/v4 从 default_configs 删掉。
// 那会在导入 v3/v4 SoVITS 权重时 KeyError —— TTS.py 的 init_vits_weights 用
// default_configs[model_version] 查 LoRA 底模，model_version 来自权重文件头。
test('default_configs 必须仍然保留 v3/v4 全表（删了会 KeyError）', () => {
  const start = ttsSrc.indexOf('default_configs = {');
  assert.notStrictEqual(start, -1, 'TTS.py 里找不到 default_configs');
  const table = ttsSrc.slice(start, start + 4000);
  for (const v of ['"v1"', '"v2"', '"v3"', '"v4"']) {
    assert.ok(
      table.includes(v + ':'),
      `default_configs 里少了 ${v}：init_vits_weights 用 default_configs[model_version] ` +
      '查 LoRA 底模，model_version 是从权重文件头读的，导入该版本模型时会 KeyError。' +
      '不需要的是「把它倒进 yaml」，不是「把它从表里删掉」');
  }
});

// ---- 模板侧：Repair-EngineConfig 拿它做重置源，它脏就等于每次重置都脏 ----
test('tts_infer.yaml.example 里没有 v3/v4 段', () => {
  for (const v of ['v3', 'v4']) {
    assert.ok(
      !new RegExp('^' + v + ':', 'm').test(exampleSrc),
      `模板里有 ${v}: 段。它的权重从没下载过，路径指向不存在的 ` +
      'GPT_SoVITS/pretrained_models/ —— 每次从模板重置都会重新种下死路径');
  }
});

test('tts_infer.yaml.example 里没有绝对路径', () => {
  const bad = exampleSrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /:\s*["']?[A-Za-z]:[\\/]/.test(l));
  assert.deepStrictEqual(
    bad, [],
    '模板里有本机绝对路径。模板是所有机器的重置源，写死盘符等于把这台机器的' +
    '布局发给每一台机器');
});
