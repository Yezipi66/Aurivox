'use strict'
// manifestAutoFill 守的 bug：第 4 步的名片把 runtime.checkpoints 填到别的目录，
//   于是第 3 步说权重下好了、第 5 步说目录不存在（两个判据看的是两个地方）。
//
// 判据：runtime.checkpoints 自动填成第 3 步的落盘路径，且只在该填的时候填。
//   该填：引擎 id 定了、这一格还是空的、落盘路径拿得到。
//   不该填：使用者已经填过（不许覆盖）、id 还没定（算不出路径）、没有路径。

const { test } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const AUTO_FILL = path.join(__dirname, '..', 'editor', 'manifestAutoFill.js')

let shouldAutoFillCheckpoints
let withAutoFilledCheckpoints
let manifestForEngineSwitch
let checkpointOwner

test('加载 manifestAutoFill.js', async () => {
  const m = await import(pathToFileURL(AUTO_FILL).href)
  shouldAutoFillCheckpoints = m.shouldAutoFillCheckpoints
  withAutoFilledCheckpoints = m.withAutoFilledCheckpoints
  manifestForEngineSwitch = m.manifestForEngineSwitch
  checkpointOwner = m.checkpointOwner
  assert.strictEqual(typeof shouldAutoFillCheckpoints, 'function')
  assert.strictEqual(typeof withAutoFilledCheckpoints, 'function')
  assert.strictEqual(typeof manifestForEngineSwitch, 'function')
  assert.strictEqual(typeof checkpointOwner, 'function')
})

const CP = 'engines/index-tts/checkpoints'

// ① 该填
test('引擎 id 定了、这一格空着、路径拿得到 ⇒ 该填', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts' }, CP), true)
})

test('runtime 段在但没有 checkpoints 这一格 ⇒ 该填', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts', runtime: { python: 'engines/x/.venv' } }, CP),
    true)
})

// ② 不该填
test('使用者已经填过 ⇒ 不填（不许覆盖他填的）', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts', runtime: { checkpoints: 'models/tts/x' } }, CP),
    false)
})

test('引擎 id 还没定 ⇒ 不填（算不出这一台的路径）', () => {
  assert.strictEqual(shouldAutoFillCheckpoints({}, CP), false)
  assert.strictEqual(shouldAutoFillCheckpoints(null, CP), false)
  assert.strictEqual(shouldAutoFillCheckpoints({ id: '' }, CP), false)
})

test('落盘路径还没拿到 ⇒ 不填', () => {
  assert.strictEqual(shouldAutoFillCheckpoints({ id: 'index-tts' }, null), false)
  assert.strictEqual(shouldAutoFillCheckpoints({ id: 'index-tts' }, ''), false)
})

// ②b 换引擎后，这一格指着一台别的引擎 ⇒ 该改
//
// 这一格残留的是上一台的权重路径。判据：落盘路径是 engines/<id>/checkpoints
// 这一族，路径里的引擎名与当前名片的 id 不一致。
test('这一格指着另一台引擎 ⇒ 改（换引擎时留下的残留）', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints(
      { id: 'other-tts', runtime: { checkpoints: 'engines/index-tts/checkpoints' } }, CP),
    true)
})

test('这一格指着当前这台 ⇒ 不改（已经是它自己的路径）', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts', runtime: { checkpoints: CP } }, CP),
    false)
})

test('这一格指的不是 engines/<id>/checkpoints 这一族 ⇒ 不改（使用者自己填的）', () => {
  assert.strictEqual(
    shouldAutoFillCheckpoints({ id: 'index-tts', runtime: { checkpoints: 'D:/somewhere/weights' } }, CP),
    false)
})

test('checkpointOwner：读出落盘路径属于哪台引擎', () => {
  assert.strictEqual(checkpointOwner('engines/index-tts/checkpoints'), 'index-tts')
  assert.strictEqual(checkpointOwner('engines\\index-tts\\checkpoints'), 'index-tts')
  assert.strictEqual(checkpointOwner('models/tts/index-tts'), null)
  assert.strictEqual(checkpointOwner(''), null)
  assert.strictEqual(checkpointOwner(null), null)
})

// ③ 填出来的样子
test('填完的那一格就是落盘路径，别的一格不动', () => {
  const before = { id: 'index-tts', runtime: { python: 'engines/x/.venv' } }
  const after = withAutoFilledCheckpoints(before, CP)
  assert.strictEqual(after.runtime.checkpoints, CP)
  assert.strictEqual(after.runtime.python, 'engines/x/.venv')
  assert.strictEqual(after.id, 'index-tts')
  // 原对象不动：React 靠引用变化判断要不要重渲染
  assert.strictEqual(before.runtime.checkpoints, undefined)
})

test('名片没有 runtime 段 ⇒ 填完会多出一个 runtime 段', () => {
  const after = withAutoFilledCheckpoints({ id: 'index-tts' }, CP)
  assert.strictEqual(after.runtime.checkpoints, CP)
})

// ④ 与后端同源：填的值必须是后端算出来的那个
test('填的值与后端落盘路径同源（core/checkpointsPath.js）', async () => {
  const { checkpointsRelPath } = require('../core/checkpointsPath.js')
  const rel = checkpointsRelPath('index-tts')
  assert.strictEqual(rel, CP)
  // 后端送来的路径与它算出来的一致
  const after = withAutoFilledCheckpoints({ id: 'index-tts' }, rel)
  assert.strictEqual(after.runtime.checkpoints, checkpointsRelPath('index-tts'))
})

// ⑤ 文件里不许出现具体引擎名（活代码）
test('manifestAutoFill.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const fs = require('node:fs')
  const src = fs.readFileSync(AUTO_FILL, 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

// ⑥ 换引擎：上一台的痕迹必须清干净。
//
// 这条守的是换引擎时的串号问题：
//   在左栏先选一台磁盘上有名片的引擎，再选一台还没名片的引擎，
//   中栏的表单里 runtime 与 call 整段还是上一台的
//   （python 路径、checkpoints、verify 里的类名、call.class 等），
//   而 id 已经写成了新引擎 ⇒ 一张「id 是新引擎、里面跑上一台」的名片。
//
// 起因是只改 id：{ ...manifest, id } 把上一台的段原样带过去了。
//
// 下面 fixture 里用的是真引擎名（fixture 数据，守卫允许）：
// 要真的验出「残留」，得用真名字；用假名字验不出上一台的痕迹。

const PREV = {
  id: 'cosyvoice2',
  label: 'CosyVoice2 0.5B',
  contract_version: 2,
  runtime: {
    python: 'engines/cosyvoice2/.venv',
    entry: '../../lib/engines/host.py',
    checkpoints: 'models/tts/cosyvoice2',
    verify: { imports: [{ module: 'cosyvoice.cli.cosyvoice', class: 'CosyVoice2' }] },
  },
  call: { kind: 'python', module: 'cosyvoice.cli.cosyvoice', class: 'CosyVoice2' },
  models: { source: { command: 'python -m cosyvoice.cli.cosyvoice' } },
  capabilities: { output_sample_rate: 24000 },
  parameters: [{ name: 'spk_id', type: 'text' }],
  output_formats: ['wav'],
  maps: { text: 'text' },
  install: { kind: 'uv' },
  upstream: { repo: 'example/cosyvoice' },
  _comment_上游: '这段注释描述的是上一台引擎',
  _comment_call: '这段注释也描述的是上一台引擎',
}

test('换引擎：上一台的 runtime 与 call 整段清掉', () => {
  const next = manifestForEngineSwitch(PREV, 'spark-tts')
  assert.strictEqual(next.runtime, undefined,
    'runtime 是上一台的，整段留着就是「id 写着 spark-tts、路径却指 cosyvoice2」')
  assert.strictEqual(next.call, undefined, 'call 是上一台的，整段留着就装着上一台的类')
})

test('换引擎：models / capabilities / parameters / maps / install / upstream 同样清掉', () => {
  const next = manifestForEngineSwitch(PREV, 'spark-tts')
  for (const k of ['models', 'capabilities', 'parameters', 'maps', 'install',
    'upstream', 'output_formats']) {
    assert.strictEqual(next[k], undefined, `${k} 是上一台的，没清掉`)
  }
})

test('换引擎：顶层的单值字段也清掉（预算 / 地址 / 模型位）', () => {
  const withTop = {
    ...PREV,
    max_chars: 200,
    max_chars_source: 'estimated',
    timeout_ms: 180000,
    timeout_ms_source: 'estimated',
    base_url_env: 'PREV_ENGINE_BASE_URL',
    default_base_url: 'http://127.0.0.1:9882',
    weights: [{ id: 'w1' }],
    local_changes: '改了启动脚本',
  }
  const next = manifestForEngineSwitch(withTop, 'spark-tts')
  for (const k of ['max_chars', 'max_chars_source', 'timeout_ms', 'timeout_ms_source',
    'base_url_env', 'default_base_url', 'weights', 'local_changes']) {
    assert.strictEqual(next[k], undefined,
      `${k} 是上一台的，没清掉 ⇒ 表单里留着上一台的预算与地址`)
  }
})

test('换引擎：id 与 label 换成新的，contract_version 留着', () => {
  const next = manifestForEngineSwitch(PREV, 'spark-tts')
  assert.strictEqual(next.id, 'spark-tts')
  assert.strictEqual(next.label, 'spark-tts',
    'label 描述的是上一台，留着就是「id 是 spark-tts、label 写着 CosyVoice2」')
  assert.strictEqual(next.contract_version, 2,
    'contract_version 是名片自身的声明，与哪台引擎无关，不该被清掉')
})

test('换引擎：下划线开头的注释键清掉（注释描述的是上一台）', () => {
  const next = manifestForEngineSwitch(PREV, 'spark-tts')
  assert.strictEqual(next._comment_上游, undefined)
  assert.strictEqual(next._comment_call, undefined)
  assert.ok(!Object.keys(next).some((k) => k.startsWith('_')),
    '还有下划线开头的键留在新名片里')
})

test('换引擎：原对象不动（React 靠引用变化判断要不要重渲染）', () => {
  const before = JSON.parse(JSON.stringify(PREV))
  manifestForEngineSwitch(PREV, 'spark-tts')
  assert.deepStrictEqual(PREV, before, '原名片被就地改了')
})

test('换引擎：清单之外的段留着（不在平台验的那些段里，不替平台猜）', () => {
  const next = manifestForEngineSwitch(
    { ...PREV, 自定义段: { keep: true } }, 'spark-tts')
  assert.deepStrictEqual(next.自定义段, { keep: true })
})

test('换引擎：清完的名片不会指向上一台的路径（整条链查一遍）', () => {
  const next = manifestForEngineSwitch(PREV, 'spark-tts')
  const dumped = JSON.stringify(next)
  assert.ok(!dumped.includes('cosyvoice'),
    '清完的名片里还有上一台的名字：' + dumped)
  assert.ok(!dumped.includes('CosyVoice'), '清完的名片里还有上一台的类名：' + dumped)
})
