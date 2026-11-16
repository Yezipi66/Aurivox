'use strict'
// 第 5 步：合成校验失败时，界面要说清三件事：
//   为什么（cause）、接下来做什么（hint）、引擎自己说了什么（原文）。
// 只有一句「宿主返回 400」的时候，用户既不知道是不是自己填错，也不知道从哪改。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

function loadJsx (file, stubMap) {
  const code = esbuild().transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'),
    { loader: 'jsx', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  const stub = (id) => {
    for (const [k, v] of Object.entries(stubMap)) {
      if (id === k || id.endsWith(k)) return v
    }
    // 下拉换成了页面内的组件，这里只要能选值就够，交互细节由真组件那条测试守。
    if (id.endsWith('components/common/Select')) return require('./_selectStub.js')
    throw new Error(file + ' 的依赖不该被求值：' + id)
  }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', '__filename', '__dirname', code)(
    mod.exports, stub, mod, path.join(EDITOR_DIR, file), EDITOR_DIR)
  return mod.exports
}

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5199/', pretendToBeVisual: true,
})
const define = (key, value) => {
  Object.defineProperty(global, key, { value, writable: true, configurable: true })
}
define('window', dom.window)
define('document', dom.window.document)
define('navigator', dom.window.navigator)
define('HTMLElement', dom.window.HTMLElement)
define('Element', dom.window.Element)
define('Node', dom.window.Node)
define('getComputedStyle', dom.window.getComputedStyle)
define('requestAnimationFrame', (cb) => setTimeout(() => cb(1), 0))
define('cancelAnimationFrame', (id) => clearTimeout(id))

let checksReply = null
// A 级请求故意慢一点：要看的是「运行中」这一段界面的样子。
let slowTierA = false
// B 级一直不返回：首屏那十几秒里界面长什么样，是这条测试要看的东西。
let holdTierB = false
// B 级晚回来多久：首屏自动跑的 B 与使用者点的 A 会并发，慢的那次可能后到。
let tierBDelay = 0
define('fetch', async (url) => {
  const u = String(url)
  if (holdTierB && u.includes('audio=B')) return new Promise(() => {})
  if (tierBDelay && u.includes('audio=B')) await new Promise((r) => setTimeout(r, tierBDelay))
  if (u.includes('/wizard/verify/ref')) {
    return { ok: true, json: async () => ({ ok: true, reference_audio: '', reference_text: '' }) }
  }
  if (slowTierA && u.includes('audio=A')) await new Promise((r) => setTimeout(r, 400))
  const body = u.includes('/wizard/hardware') ? { device_options: [] } : checksReply
  return { ok: true, json: async () => body, headers: { get: () => 'application/json' } }
})

const { StepVerify } = loadJsx('StepVerify.jsx', {
  react: React,
  'web/src/lib/i18n': { __esModule: true, useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
  'components/common/Player': { __esModule: true, Player: () => null },
  'components/common/DeviceSelect': { __esModule: true, default: () => null },
  'web/src/lib/previewMode': {
    __esModule: true,
    getPreviewMode: () => 'waveform',
    setPreviewMode: () => {},
  },
  'web/src/lib/refAudio': {
    __esModule: true,
    cleanPathInput: (s) => String(s == null ? '' : s).trim(),
  },
  './downloadRunner': { __esModule: true, readSse: async () => {} },
  './measureProgress': {
    __esModule: true,
    MEASURE_POLL_MS: 1000,
    measureStageLabel: (s) => String(s || ''),
    formatElapsed: () => '',
    measureRunning: () => false,
  },
})

const PREFLIGHT = {
  env_shallow: { ok: true, titleZh: '运行环境完整性', titleEn: 'Environment', whyZh: '查解释器与入口', why: 'checks the interpreter' },
  env_deep: { ok: true, titleZh: '引擎模块可导入', titleEn: 'Import', whyZh: '查模块导入', why: 'imports the entry' },
  checkpoints: { ok: true, ready: true, titleZh: '模型权重完整性', titleEn: 'Weights', whyZh: '查权重文件', why: 'checks weights', missing: [] },
}

const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
const settle = () => new Promise((resolve) => setTimeout(resolve, 120))

async function show (audio) {
  checksReply = { ok: true, checks: { ...PREFLIGHT, audio } }
  root.render(React.createElement(StepVerify, { key: String(Math.random()), id: 'demo' }))
  await settle()
}

test('A 级失败：同时给出原因、建议与引擎原文', async () => {
  await show({
    ok: false, level: 'A', stage: 'synth', error: '宿主返回 400',
    cause: '显存或内存不足，模型没有加载到推理设备上',
    hint: '改用更小的权重或更短的文本。',
    detail: 'Traceback (most recent call last):\n  File "infer.py", line 9\nRuntimeError: CUDA out of memory',
  })
  const text = container.textContent
  assert.ok(text.includes('失败原因'), '要有「失败原因」这一块，不能只给一句 error')
  assert.ok(text.includes('显存'), '根因要对使用者可读')
  assert.ok(text.includes('建议'), '要说接下来做什么')
  assert.ok(text.includes('引擎与宿主的原始输出'), '原文要能展开看')
  assert.ok(text.includes('CUDA out of memory'),
    '原文要真的在页面上，而不是只给一句概括')
})

test('A 级通过：不出现失败块', async () => {
  await show({
    ok: true, level: 'A', wav: { duration_sec: 1.2, sample_rate: 24000, channels: 1 },
  })
  const text = container.textContent
  assert.ok(!text.includes('失败原因'), '通过了就不该挂一块失败原因')
  assert.ok(text.includes('通过'), '通过的结论要显示')
})

test('⭐⭐⭐ A 级在跑：面板留在原地，按钮就地变成运行中', async () => {
  // 旧实现用 loading 换掉了整步：点一次 A 级，整页变成一行「正在校验…」，
  //   跑完回来结论与上一次一模一样 ⇒ 使用者判定为「点了没反应」。
  //   正确表现是：已有结论时不动面板，只有按钮与计时变化。
  await show({ ok: true, level: 'B' })
  assert.ok(container.textContent.includes('模型权重完整性'), '前置条件：结论区已经渲染')

  slowTierA = true
  const btn = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '执行 A 级校验')
  assert.ok(btn, '要有「执行 A 级校验」按钮')
  btn.click()
  await settle()

  const text = container.textContent
  assert.ok(text.includes('正在运行…'), '按钮上的文案要变成运行中')
  assert.ok(text.includes('已用时间'), '运行中要给已用时间，否则长时间校验看不出还在跑')
  assert.ok(text.includes('模型权重完整性'),
    '⛔ 已有结论时整块被换成了占位行：面板必须留在原地')

  // 等这次请求走完，组件清掉计时器；否则测试进程被 setInterval 挂住。
  await new Promise((resolve) => setTimeout(resolve, 500))
  slowTierA = false
  assert.ok(!container.textContent.includes('正在运行…'), '跑完要恢复按钮')
})

test('⭐⭐⭐ 首屏还没有结论：面板照常渲染，不是一行占位字', async () => {
  // 首屏的 B 级要真起一次解释器（本机十几秒）。这期间把整步换成一行
  //   「正在校验…」的话，页面看上去就是空的、按钮也不在，和「刷新了」
  //   没有分别。界面必须一开始就是完整的面板，加载进度写在结论区顶上。
  holdTierB = true
  root.render(React.createElement(StepVerify, { key: 'boot', id: 'demo' }))
  await settle()
  const text = container.textContent
  assert.ok(text.includes('模型权重完整性'), '⛔ 首屏不许整块换成占位行：四大块要从一开始就在')
  assert.ok(text.includes('语音合成可用性'), '合成块也要在')
  assert.ok(text.includes('正在校验…'), '要给一条加载提示，不能静默')
  assert.ok([...container.querySelectorAll('button')]
    .some((b) => b.textContent.trim() === '执行 A 级校验'),
  '按钮要在：首屏跑 B 级时，A 级按钮不能跟着显示「正在运行…」')
  holdTierB = false
})

test('参考音频是文件选择控件，不是只能手打路径', async () => {
  holdTierB = true
  root.render(React.createElement(StepVerify, { key: 'pick', id: 'demo' }))
  await settle()
  const pick = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '选择文件…')
  assert.ok(pick, '要有「选择文件…」按钮')
  const input = container.querySelector('input[type=file]')
  assert.ok(input, '按钮背后要有一个真实的 file 输入')
  assert.ok(/audio/.test(input.getAttribute('accept') || ''), 'accept 要限定音频')
  holdTierB = false
})

// A 级通过的形状：试听区靠 wav 头里的时长认样本。
const A_PASS = {
  ok: true, level: 'A',
  wav: {
    ok: true, wav_bytes: 54140, frames: 27048,
    sample_rate: 24000, channels: 1, duration_sec: 1.127,
  },
  audio_path: 'engines/demo/.wizard-verify-audio/verify-demo.wav',
}

test('⭐⭐⭐ 晚到的 B 级不许把已经拿到的 A 级结论盖回去', async () => {
  // 首屏会自动跑一次 B 级。B 要起一台临时宿主，慢的时候它的响应会在 A 级之后才到；
  //   盖回 A 的结论后，试听区回到「没有样本」，看起来就是 A 级点了没反应。
  checksReply = { ok: true, checks: { ...PREFLIGHT, audio: A_PASS } }
  root.render(React.createElement(StepVerify, { key: 'race', id: 'demo' }))
  await settle()

  const runA = [...container.querySelectorAll('button')]
    .find((b) => /执行 A 级校验/.test(b.textContent || ''))
  assert.ok(runA && !runA.disabled, 'A 级按钮应当可点')
  runA.click()
  await settle()
  assert.match(container.textContent, /1\.127s/, 'A 级通过后要显示样本时长')

  // 换一台引擎会重跑首屏那条 effect，于是又发一次 B 级。这次让它晚到。
  checksReply = {
    ok: true,
    checks: {
      ...PREFLIGHT,
      audio: { ok: true, level: 'B', audio_path: A_PASS.audio_path },
    },
  }
  tierBDelay = 300
  root.render(React.createElement(StepVerify, { key: 'race', id: 'demo2' }))
  await new Promise((r) => setTimeout(r, 600))
  tierBDelay = 0

  assert.match(container.textContent, /1\.127s/,
    '⛔ 晚到的 B 级把 A 级结论覆盖了：试听区会回到没有样本的样子')
})

test('收尾：卸掉挂起的渲染，别让计时器拖住测试进程', async () => {
  // 上面两条让 B 级一直不返回，组件就一直在「加载中」，500ms 的计时器也一直在跑。
  //   这里换成一次正常的渲染再卸载，effect 的清理才会执行，进程才能退出。
  holdTierB = false
  root.render(React.createElement(StepVerify, { key: 'final', id: 'demo' }))
  await settle()
  root.unmount()
})
