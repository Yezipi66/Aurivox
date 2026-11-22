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
// 记录校验请求，「重新检验」用的是哪条端点由它验。
let fetchLog = []
// 挡住重新检验的响应：好让「重新检验中…」这一态停在屏幕上可断言。
let recheckGate = null
// A 级请求故意慢一点：要看的是「运行中」这一段界面的样子。
let slowTierA = false
// B 级一直不返回：首屏那十几秒里界面长什么样，是这条测试要看的东西。
let holdTierB = false
// 资产栏端点是否失败：默认可用，只有「读不到清单」那条用例打开它。
let assetsFail = false
// 资产栏端点回一份结构不同的 JSON：用来验「形状不对」不会被当成「没有资产」。
let assetsWrongShape = false
// B 级晚回来多久：首屏自动跑的 B 与使用者点的 A 会并发，慢的那次可能后到。
let tierBDelay = 0
// A 级走的是 SSE：假一份 body.getReader，按帧吐事件。
//   第二帧之前按 slowTierA 停一下，好让「运行中」这一态在断言时还立着。
function sseResponse (events, holdMs = 0) {
  const enc = new TextEncoder()
  const frames = events.map(([ev, data]) =>
    enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
  let i = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          // 停在 result 之前：stage 与第一行先到，界面才有「有内容且仍在运行」这一态可断言。
          if (i === 2 && holdMs) await new Promise((r) => setTimeout(r, holdMs))
          if (i < frames.length) return { value: frames[i++], done: false }
          return { value: undefined, done: true }
        },
      }),
    },
  }
}

define('fetch', async (url) => {
  const u = String(url)
  fetchLog.push(u)
  if (u.includes('audio=none') && recheckGate) {
    // 不立即回：让「重新检验中…」停在界面上，同时记下这条请求确实发出去了。
    return new Promise((resolve) => {
      recheckGate.push(() => resolve({ ok: true, json: async () => checksReply,
        headers: { get: () => 'application/json' } }))
    })
  }
  if (u.includes('/wizard/verify/audio-stream')) {
    return sseResponse([
      ['stage', { name: 'starting' }],
      ['line', { text: 'loading model...\n', err: true }],
      ['result', { checks: { audio: (checksReply && checksReply.checks && checksReply.checks.audio)
        || { ok: true, level: 'A' } } }],
      ['done', {}],
    ], slowTierA ? 400 : 0)
  }
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
  'components/common/Player': {
    __esModule: true,
    Player: () => null,
    AudioPlayer: () => null,
  },
  'components/common/DeviceSelect': { __esModule: true, default: () => null },
  'web/src/lib/previewMode': {
    __esModule: true,
    getPreviewMode: () => 'waveform',
    setPreviewMode: () => {},
  },
  'web/src/lib/refAudio': {
    __esModule: true,
    cleanPathInput: (s) => String(s == null ? '' : s).trim(),
    refInRange: () => true,
  },
  // 右侧资产栏走向导自己的端点（/wizard/assets/*）：给一份能列出来的清单。
  //   缺文件的切片（exists=false）留在桩里，用来验界面会把它过滤掉。
  'web/src/lib/api': {
    __esModule: true,
    api: async (p) => {
      const u = String(p)
      if (assetsFail) return { ok: false, data: {} }
      if (u.includes('/wizard/assets/voices')) {
        // 形状照 /api/voices 原样：body 顶层就是 voices。
        if (assetsWrongShape) {
          return { ok: true, data: { ok: true, data: { voices: [{ id: 'VoiceA' }] } } }
        }
        return { ok: true, data: { voices: [{ id: 'VoiceA', display_name: '音色甲', language: 'zh' }] } }
      }
      if (u.includes('/wizard/assets/segments')) {
        return { ok: true, data: { ok: true, segments: { segments: [
          { audio_filename: 'seg-1.wav', text: '第一句', scene: '场景', index: 0, duration: 1, exists: true },
          { audio_filename: 'gone.wav', text: '已删', scene: '场景', index: 1, duration: 1, exists: false },
        ] } } }
      }
      if (u.includes('/wizard/assets/raw-list')) {
        return { ok: true, data: { ok: true, raw: [{ filename: 'take1.wav', text: '原始', duration: 1 }] } }
      }
      return { ok: false, data: {} }
    },
  },
  // Stage 抽屉在此只透传内容，真实交互由浏览器那条验证守。
  './Stage': {
    __esModule: true,
    default: ({ center, right }) => React.createElement('div', null, center, right),
  },
  './paramDrop': { __esModule: true, REF_MIME: 'application/x-aurivox-ref' },
  // 大框与分段框都是纯结构，本测试只验失败文案的渲染。
  './StepCard': {
    __esModule: true,
    default: ({ title, children }) => React.createElement('section', null,
      React.createElement('h2', null, title), children),
  },
  './boxStyle': {
    __esModule: true,
    BOX: { marginBottom: 6, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6 },
    BOX_GAP: 8,
  },
  // 第 5 步按引擎存用户输入与视图开合；此测试只验渲染，存档读写都为空操作。
  './useInstallSession': {
    __esModule: true,
    loadSession: () => null,
    saveSession: () => {},
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
  // 输出只有一块 .log-view：运行中实时，跑完留在原地，不换组件。
  const view = container.querySelector('.log-view')
  assert.ok(view, '原文要落在日志视图里，不能只给一句概括')
  assert.ok(view.textContent.includes('CUDA out of memory'),
    '原文要真的在页面上，而不是只给一句概括')
})

test('⭐⭐⭐ 引擎模块导入失败：明细、诊断结论、办法、环境事实分层，不混成一段', async () => {
  // 逐条导入明细是探针 JSON 的 checks 项，不是 stdout：与另外两道静态核对一样
  //   用 field-hint 平铺，不造一个黑框冒充原始输出。结论进 .msg-danger，办法带
  //   「建议：」，版本与解释器单列，三层语义仍各有归属。
  checksReply = {
    ok: true,
    checks: {
      ...PREFLIGHT,
      env_deep: {
        ok: false, titleZh: '引擎模块可导入', titleEn: 'Import',
        whyZh: '查模块导入', why: 'imports the entry',
        problems: [
          "_MODULE_：import failed: ModuleNotFoundError: No module named '_MODULE_'",
          '引擎的运行环境缺少依赖：_MODULE_ 没有装上。',
          '用 uv 把它装进引擎的解释器。',
        ],
        import_diagnostics: [
          {
            module: '_MODULE_',
            cause: '引擎的运行环境缺少依赖：_MODULE_ 没有装上',
            causeEn: 'missing dependency: _MODULE_',
            hint: '使用uv在该引擎的虚拟环境安装_MODULE_',
            hintEn: 'Install _MODULE_ into the engine virtual environment with uv',
            missingPackage: 'urllib3',
          },
        ],
        info: {
          python: { version: '3.11.15' },
          paths: { python: 'D:\\engines\\demo\\.venv\\Scripts\\python.exe' },
          checks: [{ module: '_MODULE_', ok: false,
            detail: "import failed: ModuleNotFoundError: No module named '_MODULE_'",
            detailZh: "import 失败: ModuleNotFoundError: No module named '_MODULE_'" }],
        },
      },
    },
  }
  root.render(React.createElement(StepVerify, { key: String(Math.random()), id: 'demo' }))
  await settle()
  // 详细校验项默认收起，先展开才能看到 env_deep 那四层。
  const detailed = [...container.querySelectorAll('.field-label')]
    .find((n) => n.textContent.includes('详细校验项'))
  detailed.click()
  await settle()

  // 明细和另外两道静态核对同格式：field-hint 平铺，不造 .log-view 黑框冒充 stdout。
  const envBlock = [...container.querySelectorAll('.field-label')]
    .find((n) => n.textContent.includes('引擎模块可导入')).parentElement
  const detail = [...envBlock.querySelectorAll('.field-hint')]
    .find((n) => n.textContent.includes('ModuleNotFoundError'))
  assert.ok(detail, '逐条导入结论要平铺出来，且和静态明细同一种 field-hint')
  assert.ok(!envBlock.querySelector('.log-view'),
    '探针 stdout 是 JSON 协议通道，不能造一个输出黑框')
  // 诊断结论独立成危险块，办法独立成「建议：」，都不混进明细行。
  const danger = [...container.querySelectorAll('.msg-danger')]
    .find((n) => n.textContent.includes('运行环境缺少依赖'))
  assert.ok(danger, '诊断结论要单独成块，不能混在导入明细那一行')
  assert.ok(!detail.textContent.includes('运行环境缺少依赖'), '结论不该混进明细行')
  assert.ok(container.textContent.includes('建议：'), '办法要有独立的「建议」引导')
  // 安装命令用第 2 步同款命令框输出真实路径与包名，界面上不留花括号占位符。
  const cmd = [...envBlock.querySelectorAll('.rc-cmd-body')]
    .find((n) => n.textContent.includes('uv pip install'))
  assert.ok(cmd, '安装命令要进命令框，不混在说明文字里')
  assert.match(cmd.textContent, /uv pip install --python D:\\engines\\demo\\.venv\\Scripts\\python\.exe urllib3/,
    '命令要填真实 venv 路径与缺包名')
  assert.doesNotMatch(container.textContent, /\{miss_package\}|\{\.venv\}/, '不能留下模板占位符')
  // 环境事实单列，且带 word-break：长路径不能被布局挤压。
  assert.ok(container.textContent.includes('3.11.15'), 'Python 版本要列出来')
  assert.ok(container.textContent.includes('python.exe'), '解释器路径要列出来')
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
  assert.ok(container.textContent.includes('详细校验项'), '前置条件：结论区已经渲染')

  slowTierA = true
  const btn = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '执行 A 级校验')
  assert.ok(btn, '要有「执行 A 级校验」按钮')
  btn.click()
  await settle()

  const text = container.textContent
  assert.ok(text.includes('正在运行…'), '按钮上的文案要变成运行中')
  assert.ok(text.includes('已用时间'), '运行中要给已用时间，否则长时间校验看不出还在跑')
  assert.ok(text.includes('详细校验项'),
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
  assert.ok(text.includes('详细校验项'), '⛔ 首屏不许整块换成占位行：结论面板要从一开始就在')
  assert.ok(text.includes('语音合成可用性'), '合成块也要在')
  assert.ok(text.includes('正在校验…'), '要给一条加载提示，不能静默')
  assert.ok([...container.querySelectorAll('button')]
    .some((b) => b.textContent.trim() === '执行 A 级校验'),
  '按钮要在：首屏跑 B 级时，A 级按钮不能跟着显示「正在运行…」')
  holdTierB = false
})

test('详细校验项与校验结论同框，详细在前且默认收起', async () => {
  await show({ ok: true, level: 'B' })
  // 两块都是机械式检验，收在同一张 .section 里；小标题是框内的 .field-label。
  const sec = [...container.querySelectorAll('.section')].find((s) => {
    const h = s.querySelector('.section-hdr h2')
    return h && h.textContent.includes('引擎运行环境检验')
  })
  assert.ok(sec, '机械式检验要收在一张 .section 卡片里')
  const labels = [...sec.querySelectorAll('.field-label')]
  const detailed = labels.find((n) => n.textContent.includes('详细校验项'))
  const overview = labels.find((n) => n.textContent.includes('校验结论'))
  assert.ok(detailed, '框内要有「详细校验项」小标题')
  assert.ok(overview, '框内要有「校验结论」小标题')
  const all = sec.querySelector('.section-body')
  assert.ok(all.textContent.indexOf('详细校验项') < all.textContent.indexOf('校验结论'),
    '详细校验项要排在校验结论之前')
  assert.ok(detailed.textContent.includes('项通过'), '通过数留在标题上，收起也看得见')
  assert.strictEqual(detailed.getAttribute('aria-expanded'), 'false', '默认收起：证据不占首屏')
  assert.ok(!all.textContent.includes('模型权重完整性'), '默认收起时证据不出现')
  // 结论也可折叠，且默认展开（进来就该看到结果）；两块之间一条分隔线。
  assert.strictEqual(overview.getAttribute('aria-expanded'), 'true', '结论默认展开')
  const divider = [...all.children].some((n) => {
    const b = n.style && n.style.borderTop
    return b && b.includes('var(--border)') && /8px 0/.test(n.style.margin || '')
  })
  assert.ok(divider, '详细项与结论之间要有一条分隔线')
  detailed.click()
  await settle()
  const text = sec.textContent
  assert.ok(text.includes('运行环境完整性'), '展开后要看到环境完整性')
  assert.ok(text.includes('引擎模块可导入'), '展开后要看到模块导入')
  assert.ok(text.includes('模型权重完整性'), '展开后要看到权重核对')
  assert.strictEqual(detailed.getAttribute('aria-expanded'), 'true', '展开后标题行的状态要跟上')
  // 结论点一下要能收起：内容整块消失，标题状态跟着变。
  assert.ok(text.includes('接入前置检查'), '展开态要看到结论内容')
  overview.click()
  await settle()
  assert.strictEqual(overview.getAttribute('aria-expanded'), 'false', '点标题后结论要收起')
  assert.ok(!sec.textContent.includes('接入前置检查'), '收起后结论内容不该还留在 DOM 里')
})

test('⭐ 重新检验：只重跑三道静态核对，不动合成那道', async () => {
  // 首屏 B 级给出的 audio 结果要留住：重新检验只覆盖三道静态核对。
  //   整份替换会把 A/B 级结论抹掉，合成那一项白跑。
  await show({ ok: false, level: 'A', error: '合成失败', cause: '缺依赖', hint: '装依赖' })
  assert.ok(container.textContent.includes('合成失败'), '前置条件：合成结论在界面上')

  const btn = [...container.querySelectorAll('button')]
    .find((b) => /重新检验/.test(b.textContent || ''))
  assert.ok(btn, '引擎运行环境检验这一框要有「重新检验」按钮')

  // 挡住响应：点下去按钮要就地变成运行中，面板不能被整块换掉。
  const gate = []
  recheckGate = gate
  fetchLog = []
  btn.click()
  await settle()
  assert.strictEqual(gate.length, 1, '点一次只发一条重新检验请求')
  assert.ok(fetchLog.some((u) => u.includes('/wizard/verify/checks') && u.includes('audio=none')),
    '重新检验走 audio=none：重跑三道静态核对，跳过合成')
  assert.ok(!fetchLog.some((u) => u.includes('fast=1')),
    '不能用 fast=1：那会跳过模块导入那道，重新检验就不全了')
  assert.ok(container.textContent.includes('重新检验中…'), '运行中按钮要变成重新检验中…')
  assert.ok(container.textContent.includes('合成失败'), '⛔ 重新检验把合成结论抹掉了')

  // 放行后按钮恢复，合成结论仍在。
  gate.forEach((release) => release())
  recheckGate = null
  await settle()
  assert.ok(!container.textContent.includes('重新检验中…'), '跑完按钮要恢复')
  assert.ok(container.textContent.includes('合成失败'), '跑完合成结论仍要在，不能被静态结论盖掉')
})

test('参考音频是文件选择控件，不是只能手打路径', async () => {
  holdTierB = true
  root.render(React.createElement(StepVerify, { key: 'pick', id: 'demo' }))
  await settle()
  // 与 9886 参数面板的 file 类参数同一形状：.field-file 里一个路径框加一个文件夹图标按钮。
  //   两处按钮里都是文件夹图标而不是「选择文件…」这类文字，同一件事在两张页面上长得一样。
  const row = container.querySelector('.field-file')
  assert.ok(row, '路径框与按钮要包在 .field-file 里，与 9886 同一套容器')
  assert.ok(row.querySelector('.field-file-input'), '路径框要用 .field-file-input')
  const pick = row.querySelector('button.field-file-pick')
  assert.ok(pick, '按钮要用 .field-file-pick（图标按钮，不是宽文字按钮）')
  assert.ok(pick.querySelector('svg'), '按钮里是文件夹图标')
  assert.ok(pick.getAttribute('aria-label'), '图标按钮没有可见文字，必须有 aria-label')
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

test('点执行 A 级校验：黑框立刻出现，不等跑完', async () => {
  // 需求是「点了就要有反应」。A 级要几十秒（加载模型 + 合成），
  //   等跑完再给框等于这段时间界面什么都没发生。
  await show({ ok: true, level: 'B' })
  slowTierA = true
  const btn = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '执行 A 级校验')
  assert.ok(btn, '要有「执行 A 级校验」按钮')
  btn.click()
  await settle()
  assert.ok(container.textContent.includes('实时输出'),
    '点下去就该出现实时输出框，不能等跑完')
  const view = container.querySelector('.log-view')
  assert.ok(view, '实时输出要用专门的日志视图（.log-view），不是命令框')
  assert.ok(/loading model|正在启动宿主/.test(view.textContent),
    '框里要有内容：已收到的行，或者启动提示')
  // stderr 那一路要染红：一行一行分出来就是为了这个。
  const errLine = [...view.querySelectorAll('.log-line')]
    .find((n) => n.className.includes('error') && n.textContent.includes('loading model'))
  assert.ok(errLine, 'stderr 的行要带 .log-line.error 才染得上色')
  // 让这次流走完，组件才会清掉计时器。
  await new Promise((resolve) => setTimeout(resolve, 600))
  slowTierA = false
})

test('跑完输出不消失：同一块 .log-view 继续留着最后一行', async () => {
  // 无感衔接：运行中与跑完共用一块日志视图，不换组件、不换成 details。
  //   跑完就整块消失的话，中途没盯屏幕的人再也看不到发生了什么。
  await show({ ok: true, level: 'B' })
  const btn = [...container.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '执行 A 级校验')
  btn.click()
  await settle()
  // 等这次流走完（stub 三帧、无 hold 时很快）
  await new Promise((resolve) => setTimeout(resolve, 300))
  const view = container.querySelector('.log-view')
  assert.ok(view, '跑完后日志视图不该消失')
  assert.ok(view.textContent.includes('loading model'), '最后一轮的输出要留着重看')
  assert.ok(!container.textContent.includes('正在启动宿主'),
    '已经有行了，不该还显示启动提示')
})

test('打包成一行的原文要还原成多行，不能整段挤在一条里', async () => {
  // 宿主偶有把整段结果序列化后再交上来的情况：换行成了两个字符（反斜杠 + n），
  //   整段挤成一行。直接按真换行拆的话拆不开，读的人看到的是一串转义符。
  await show({
    ok: false, level: 'A', stage: 'synth', error: '宿主返回 500',
    detail: 'F5-TTS inference failed\\r\\nTraceback (most recent call last):\\r\\n'
      + '  File "a.py", line 1\\r\\nOSError: boom',
  })
  const view = container.querySelector('.log-view')
  assert.ok(view, '要有日志视图')
  const lines = [...view.querySelectorAll('.log-line')].map((n) => n.textContent)
  assert.ok(lines.length >= 4, '应当还原成多行，实际只有 ' + lines.length + ' 行')
  assert.ok(lines.some((l) => l.includes('OSError: boom')), '最后一行异常要在')
  assert.ok(!view.textContent.includes('\\r\\n'), '页面上不该留着字面的转义符')
})

test('混合原文：前段真换行、后段打包，两段都要能读', async () => {
  // 真实数据就长这样：host 自己的 message 是干净的，后面拼上的 traceback 是打包的。
  //   整段看一眼「已经有换行了」就跳过还原，后半段会原样留下一串 \r\n。
  await show({
    ok: false, level: 'A', stage: 'synth', error: '宿主返回 500',
    detail: 'F5-TTS inference failed\nTraceback (most recent call last):'
      + '\\r\\n  File "a.py", line 1\\r\\nOSError: boom',
  })
  const view = container.querySelector('.log-view')
  assert.ok(view, '要有日志视图')
  assert.ok(!view.textContent.includes('\\r\\n'),
    '后半段的打包片段没还原，页面上留下了字面转义')
  assert.ok(view.textContent.includes('OSError: boom'), '最后一行异常要在')
  assert.ok(view.textContent.includes('F5-TTS inference failed'), '前半段也要在')
})

test('原始输出分两路：stdout 与 stderr 各带标签，不混成一摞', async () => {
  // 引擎自己说的话（模型路径、加载进度）在 stdout，宿主的异常在 stderr。
  //   混成一摞时整块只能叫「stderr」，读的人分不清哪句是失败原因。
  await show({
    ok: false, level: 'A', stage: 'synth', error: '宿主返回 500',
    cause: '权重路径不对', hint: '核对第 3 步的权重目录。',
    detail: 'RuntimeError: python.exe 退出码 1',
    host_stdout: 'Using F5TTS_v1_Base...\nmodel : /x/model.safetensors',
    host_stderr: 'Traceback (most recent call last):\nPermissionError: [Errno 13]',
  })
  const text = container.textContent
  assert.ok(text.includes('── stdout ──'), 'stdout 段要有自己的标签')
  assert.ok(text.includes('Using F5TTS_v1_Base'), 'stdout 的内容要显示出来')
  assert.ok(text.includes('── stderr ──'), 'stderr 段要有自己的标签')
  assert.ok(text.includes('PermissionError'), 'stderr 的内容要显示出来')
  // 顺序：stdout 在 stderr 之前，与两路产生的先后一致。
  assert.ok(text.indexOf('── stdout ──') < text.indexOf('── stderr ──'),
    'stdout 段要排在 stderr 段之前')
})

test('资产栏：清单来自向导端点，缺文件的切片不列出', async () => {
  assetsFail = false
  await show({ ok: true, level: 'B' })
  await settle()
  await settle()
  const items = container.querySelectorAll('.ref-item')
  assert.strictEqual(items.length, 1, '只列磁盘上还在的切片，缺文件的要过滤掉')
  assert.ok(container.textContent.includes('第一句'), '转写文本要随条目一起显示')
  assert.ok(!container.textContent.includes('读不到音色清单'), '端点通了就不该报读不到')
})

test('资产栏：读不到音色清单时说明原因，而不是显示成没有资产', async () => {
  assetsFail = true
  await show({ ok: true, level: 'B' })
  await settle()
  assert.ok(container.textContent.includes('读不到音色清单'),
    '取不到与没有是两件事，界面上要说清')
  assetsFail = false
})

test('资产栏：响应形状不对时按读不到处理，不显示成没有资产', async () => {
  assetsWrongShape = true
  await show({ ok: true, level: 'B' })
  await settle()
  assert.ok(container.textContent.includes('读不到音色清单'),
    'HTTP 200 但结构不对，必须报读不到；静默显示「没有音色资产」会把环境问题藏起来')
  assetsWrongShape = false
})

test('收尾：卸掉挂起的渲染，别让计时器拖住测试进程', async () => {
  // 上面两条让 B 级一直不返回，组件就一直在「加载中」，500ms 的计时器也一直在跑。
  //   这里换成一次正常的渲染再卸载，effect 的清理才会执行，进程才能退出。
  holdTierB = false
  root.render(React.createElement(StepVerify, { key: 'final', id: 'demo' }))
  await settle()
  root.unmount()
})
