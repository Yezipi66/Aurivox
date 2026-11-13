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
define('fetch', async (url) => {
  const u = String(url)
  const body = u.includes('/wizard/hardware') ? { device_options: [] } : checksReply
  return { ok: true, json: async () => body, headers: { get: () => 'application/json' } }
})

const { StepVerify } = loadJsx('StepVerify.jsx', {
  react: React,
  'web/src/lib/i18n': { __esModule: true, useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
  'components/common/Player': { __esModule: true, Player: () => null },
  'components/common/DeviceSelect': { __esModule: true, default: () => null },
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
