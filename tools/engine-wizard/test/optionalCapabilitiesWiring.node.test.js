'use strict'
// 可选能力的接线守卫：填了开关 → 前端长控件 → 请求带值 → 引擎参数 → host 展开。
// 断在任意一环，症状都是「界面有这一格、填了没效果」，且不报错。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('引擎列表把可选能力送到前端：没填就不吐输出格式', () => {
  const src = read('lib/routes/engines.js')
  assert.ok(/declared_inputs: declared/.test(src), '引擎列表要下发可选能力名单')
  assert.ok(/declaredInputs\(manifest && manifest\.call\)/.test(src),
    '名单从名片 call.args 派生，不从别处猜')
  assert.ok(/output_formats: Array\.isArray\(manifest && manifest\.output_formats\)/.test(src),
    '输出格式没填时连字段都不吐')
})

test('合成服务把选中音频并进引擎参数，且只认名片写过的名字', () => {
  const src = read('lib/services/synthesisService.js')
  assert.ok(/req\.body && req\.body\.audio_inputs/.test(src), '要接住界面的 audio_inputs')
  assert.ok(/resolveAudioArgs\(manifest && manifest\.call, picked\)/.test(src),
    '只认名片写过的参数名')
  assert.ok(/cfg\.engine_params = \{ \.\.\.\(cfg\.engine_params \|\| \{\}\), \.\.\.out \}/.test(src),
    '要并进 cfg.engine_params，host 才收得到')
  assert.ok(/pathResolver\.resolveManagedRef/.test(src), '相对路径要转成绝对路径')
})

test('合成页只在名片写过长控件与发字段', () => {
  const gen = read('web/src/components/generate/GenerateTab.jsx')
  const panel = read('web/src/components/generate/AdvancedParamsPanel.jsx')
  assert.ok(/declared_inputs \|\| \[\]\)/.test(gen), '名单来自引擎对象')
  assert.ok(/audio_inputs: Object\.keys\(audioValues\)/.test(gen), '有选中才发请求字段')
  assert.ok(/\(audioInputs \|\| \[\]\)\.map/.test(panel), '按名单逐项长控件')
  assert.ok(/\(outputFormats \|\| \[\]\)\.length > 0/.test(panel), '写了输出格式才长下拉')
})

test('向导可选能力区：音频空行可直接填开关名，不再区分单选/多选', () => {
  const src = read('tools/engine-wizard/editor/OptionalCapabilities.jsx')
  // 名片没有音频项时本区直接给一个空行填开关（与运行设备同一口径），
  //   填了就写 role=audio_ref 并进 params.call_time，host 才收得到。
  assert.ok(/addAudio/.test(src), '音频空行填开关要直接开能力')
  assert.ok(/role: 'audio_ref'/.test(src), '新声明的音频项要带角色')
  assert.ok(/p\.call_time = \[\.\.\.ct, name\]/.test(src),
    '否则 host 会静默丢掉请求里带的值')
  // Picker 一律是多选列表，不再区分单选/多选：9886 那边整段按多选数组处理。
  assert.ok(!/t\('Multiple', '多选'\)/.test(src), '音频区不再有单选/多选下拉')
  assert.ok(!/Add audio input|Add weight slot/.test(src), '音频与权重都不再逐行加')
  assert.ok(/setWeights/.test(src) && /setFormats/.test(src), '多权重位与输出格式都能编辑')
})

test('可选能力填的是开关名：名片不承载运行时的取值', () => {
  const src = read('tools/engine-wizard/editor/OptionalCapabilities.jsx')
  assert.ok(!/readFlagValue|writeFlagValue|call\.argv/.test(src),
    '运行设备不再把 cuda / 0 这类值写进名片 argv')
  assert.ok(/placeholder="--device"/.test(src), '运行设备格填的是开关')
  assert.ok(/placeholder="--format"/.test(src), '输出格式格填的是开关')
  assert.ok(/role: \(args\[name\] && args\[name\]\.role\) \|\| 'output_format'/.test(src),
    '格式开关要带角色：填了开关名就补上 role，前端才长格式下拉')
  assert.ok(/setFormatFlag/.test(src) && /p\.call_time = \[\.\.\.ct, name\]/.test(src),
    '声明开关要同时写进 call_time，host 才收得到')
})

test('输出格式透传：前端按声明发值，服务端并进引擎参数，宿主按白名单展开', () => {
  const gen = read('web/src/components/generate/GenerateTab.jsx')
  const svc = read('lib/services/synthesisService.js')
  const prof = read('lib/engines/hostProfile.js')
  const decl = read('lib/engines/declaredInputs.js')
  const scan = read('tools/engine-wizard/editor/scanAutofill.js')
  assert.ok(/x\.role === 'output_format'/.test(gen), '下拉只在声明了格式开关时长出来')
  assert.ok(/format_input: formatDecl/.test(gen), '选中的格式按声明的参数名发')
  assert.ok(/resolveFormatArg\(/.test(svc) && /cfg\.engine_params/.test(svc), '服务端并进引擎参数')
  assert.ok(/'output_format'/.test(prof), '角色白名单收 output_format')
  assert.ok(/formatInput/.test(decl) && /resolveFormatArg/.test(decl), '名单与透传同一真源')
  assert.ok(/format_arg/.test(scan), '嗅探要带出格式开关，并把名字写进 call_time')
})

test('五类可选能力收在同一区，区标题统一且默认展开', () => {
  const src = read('tools/engine-wizard/editor/OptionalCapabilities.jsx')
  const opt = read('tools/engine-wizard/editor/OptionalConfig.jsx')
  assert.ok(/t\('Optional capabilities', '可选能力'\)/.test(src), '区标题用统一名字')
  assert.ok(!/平台声明|Platform declarations/.test(src), '区里不再出现旧名字')
  assert.ok(/React\.useState\(true\)/.test(src), '重要但非必填，默认展开')
  for (const [re, what] of [
    [/Runtime device/, '运行设备'],
    [/Reference text/, '参考文本'],
    [/Audio input/, '音频输入'],
    [/Slot name/, '权重位'],
    [/Output format switch/, '输出格式'],
  ]) assert.ok(re.test(src), `${what}要收进同一区`)
  assert.ok(!/Add audio input|Add weight slot/.test(src),
    '音频与权重都直接横排，不再逐行加')
  assert.ok(!/t\('Multiple', '多选'\)/.test(src),
    '音频区不再有单选/多选下拉，picker 一律是选列表')
  assert.ok(/<OptionalCapabilities\b/.test(opt), '可选能力挂在可选参数区')
  assert.ok(!/Runtime device|PlatformDeclarations/.test(opt), '运行设备不再散落在引擎配置文件里')
})
