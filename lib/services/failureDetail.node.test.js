'use strict';

// ---------------------------------------------------------------------------
//  刀 D1（2026-08-31）：兜底外壳正则不许认某一台引擎的名字
// ---------------------------------------------------------------------------
//
// ⚠ 这个模块此前**一条自己的测试都没有** —— 它只被 synthesisService 的几个
//   测试间接扫到。而它里面有两条极易踩的正则（脱敏那条会把
//   "http://127.0.0.1:9880" 当 Windows 绝对路径吃掉）。⇒ 本文件补上直接守卫。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { synthesisFailureDetail, unwrapUpstreamBody } = require('./failureDetail');

const E = (msg, props = {}) => Object.assign(new Error(msg), props);

// --- 行为不变：老路径那条消息一个字节都没变 --------------------------------

test('GPT-SoVITS 的外壳照旧剥掉（⛔ D1 不许改变今天用户看到的东西）', () => {
  assert.strictEqual(
    synthesisFailureDetail(E('GPT-SoVITS /tts failed (500): {"detail":"CUDA out of memory"}')),
    'CUDA out of memory');
});

// --- D1 修好的那件事 --------------------------------------------------------

test('⭐⭐⭐ 换任何一台引擎，外壳一样剥得掉', () => {
  for (const label of ['IndexTTS2', 'Lean TTS', 'CosyVoice2', 'nebula-tts', 'X']) {
    assert.strictEqual(
      synthesisFailureDetail(E(`${label} /tts failed (400): {"detail":"bad ref audio"}`)),
      'bad ref audio',
      `${label} 的外壳没剥掉 —— 装了这台引擎的用户会看到一整坨`);
  }
});

test('上游正文不是 JSON 时原样带出（外壳仍要剥）', () => {
  assert.strictEqual(
    synthesisFailureDetail(E('Lean TTS /tts failed (400): plain text here')),
    'plain text here');
});

// --- 锚点与限长：⛔ 不许被一坨 traceback 冒充外壳 ---------------------------

test('⭐⭐ 正则锚在开头 ⇒ traceback 中间那句 "/tts failed" 不许截断真错误', () => {
  const out = synthesisFailureDetail(E('Traceback\n  line\n/tts failed (500): fake'));
  assert.match(out, /^Traceback/, '真正的错误开头被吞掉了');
  assert.match(out, /fake$/);
});

test('⭐ label 段限长 64 ⇒ 超长前缀不算外壳', () => {
  const longLabel = 'L'.repeat(80);
  const out = synthesisFailureDetail(E(`${longLabel} /tts failed (500): x`));
  assert.ok(out.startsWith('LLL'), '超长前缀被当成 label 剥掉了');
});

test('不像外壳的消息原样返回', () => {
  assert.strictEqual(synthesisFailureDetail(E('something else entirely')),
    'something else entirely');
});

// --- 结构化字段优先（甲刀的承重），⛔ 正则只是兜底 --------------------------

test('有 upstreamBody 时走结构化字段，⛔ 不看文案', () => {
  assert.strictEqual(
    synthesisFailureDetail(E('随便什么文案', { upstreamBody: '{"detail":"real one"}' })),
    'real one');
});

test('传输层失败在脱敏之前返回 ⇒ 地址不许被当成 Windows 路径吃掉', () => {
  const out = synthesisFailureDetail(
    E('Cannot reach IndexTTS2 at http://127.0.0.1:9880 — the engine is not running (ECONNREFUSED)',
      { transport: true }));
  assert.ok(out.includes('http://127.0.0.1:9880'), '引擎地址被脱敏擦掉了');
  assert.ok(!out.includes('[path]'));
});

test('unwrapUpstreamBody：JSON 三个键的取值顺序', () => {
  assert.strictEqual(unwrapUpstreamBody('{"detail":"d","message":"m","error":"e"}'), 'd');
  assert.strictEqual(unwrapUpstreamBody('{"message":"m","error":"e"}'), 'm');
  assert.strictEqual(unwrapUpstreamBody('{"error":"e"}'), 'e');
  assert.strictEqual(unwrapUpstreamBody('not json'), 'not json');
});

// --- 归零守卫 ---------------------------------------------------------------

test('⭐⭐⭐ D1 归零判据：failureDetail.js 的代码里不许出现任何引擎名', () => {
  const src = fs.readFileSync(path.join(__dirname, 'failureDetail.js'), 'utf-8');
  const code = src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))     // 注释里可以讲历史，代码里不行
    .join('\n');
  for (const bad of ['GPT-SoVITS', 'gpt-sovits', 'IndexTTS', 'indextts']) {
    assert.ok(!code.includes(bad), `failureDetail.js 的代码里还有 ${bad}`);
  }
});

test('⭐ 正则里的外壳片段来自 upstreamError.FAILED，⛔ 不许各写一份', () => {
  const src = fs.readFileSync(path.join(__dirname, 'failureDetail.js'), 'utf-8');
  assert.ok(/require\(['"]\.\.\/engines\/upstreamError['"]\)/.test(src),
    '没有从 upstreamError 取 FAILED ⇒ 文案常量改了这边不会跟着改');
  const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\\\/tts failed/.test(code) && !code.includes("'/tts failed"),
    '正则里又写死了一份 /tts failed 字面量');
});
