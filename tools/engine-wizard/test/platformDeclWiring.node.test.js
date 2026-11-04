'use strict'
// 平台声明的接线守卫：声明 → 前端长控件 → 请求带值 → 引擎参数 → host 展开。
// 断在任意一环，症状都是「界面有这一格、填了没效果」，且不报错。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('引擎列表把声明送到前端：没声明就不吐输出格式', () => {
  const src = read('lib/routes/engines.js')
  assert.ok(/declared_inputs: declared/.test(src), '引擎列表要下发平台声明')
  assert.ok(/declaredInputs\(manifest && manifest\.call\)/.test(src),
    '声明从名片 call.args 派生，不从别处猜')
  assert.ok(/output_formats: Array\.isArray\(manifest && manifest\.output_formats\)/.test(src),
    '输出格式没声明时连字段都不吐')
})

test('合成服务把选中音频并进引擎参数，且只认声明过的名字', () => {
  const src = read('lib/services/synthesisService.js')
  assert.ok(/req\.body && req\.body\.audio_inputs/.test(src), '要接住界面的 audio_inputs')
  assert.ok(/resolveAudioArgs\(manifest && manifest\.call, picked\)/.test(src),
    '只认名片声明过的参数名')
  assert.ok(/cfg\.engine_params = \{ \.\.\.\(cfg\.engine_params \|\| \{\}\), \.\.\.out \}/.test(src),
    '要并进 cfg.engine_params，host 才收得到')
  assert.ok(/pathResolver\.resolveManagedRef/.test(src), '相对路径要转成绝对路径')
})

test('合成页只在声明存在时长控件与发字段', () => {
  const gen = read('web/src/components/generate/GenerateTab.jsx')
  const panel = read('web/src/components/generate/AdvancedParamsPanel.jsx')
  assert.ok(/declared_inputs \|\| \[\]\)/.test(gen), '名单来自引擎对象')
  assert.ok(/audio_inputs: Object\.keys\(audioValues\)/.test(gen), '有选中才发请求字段')
  assert.ok(/\(audioInputs \|\| \[\]\)\.map/.test(panel), '按声明逐项长控件')
  assert.ok(/\(outputFormats \|\| \[\]\)\.length > 0/.test(panel), '输出格式声明了才长下拉')
})

test('向导声明区：手写声明会同时写进 call_time 白名单', () => {
  const src = read('tools/engine-wizard/editor/PlatformDeclarations.jsx')
  assert.ok(/role: 'audio_ref'/.test(src))
  assert.ok(/p\.call_time = \[\.\.\.ct, name\]/.test(src),
    '否则 host 会静默丢掉请求里带的值')
  assert.ok(/setWeights/.test(src) && /setFormats/.test(src), '多权重位与输出格式都能编辑')
})
