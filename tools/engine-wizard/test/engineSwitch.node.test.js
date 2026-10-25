'use strict'
// 左栏「换引擎」的行为守卫：换到另一台引擎时，上一台的名片内容必须清干净。
//
// 这条守的是换引擎时的串号问题：
//   先选一台磁盘上有名片的引擎，再选一台还没名片的引擎，
//   中栏的表单里 runtime 与 call 整段还是上一台的，而 id 已经写成了新引擎。
//
// 下面的 fixture 里用的是真引擎名（那是 fixture 数据，守卫允许）：
// 测试要证的是「换引擎后名片里不再有上一台的东西」，
// 用真名字才能真的验出来，用假名字验不出残留。
//
// 为什么纯函数测试抓不到：manifestAutoFill.node.test.js 验的是
// manifestForEngineSwitch 这个函数算得对不对；这里验的是
// EngineIdentity 真的调了它。接线漏了（比如改回 { ...manifest, id }），
// 纯函数测试照样全绿。
//
// 所以这一层要真渲染组件、真选下拉、真看 onChange 拿到什么。
//
// 引擎下拉在中栏的身份条上（EngineIdentity.jsx），不在左栏：
// 身份跟着名片走，左栏只是扫到的参数。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')

const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))

/** 编译并加载一个 JSX 模块；外部依赖用 stub。 */
function loadJsx (file, stubMap) {
  const esb = esbuild()
  const code = esb.transformSync(fs.readFileSync(path.join(EDITOR_DIR, file), 'utf8'), {
    loader: 'jsx', format: 'cjs', target: 'node18',
  }).code
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

const i18nStub = { useT: () => ({ t: (en) => en }) }

// EngineIdentity 的两个数据源：
//   useInstalled  → 读磁盘上的名片
//   useEngineDirs → 列出 engines/ 下的目录（单独一个文件，Fast Refresh 要求）
const DIRS = [
  { id: 'cosyvoice2', manifestPresent: true },
  { id: 'spark-tts', manifestPresent: false },
]

const PREV_MANIFEST = {
  id: 'cosyvoice2',
  label: 'CosyVoice2 0.5B',
  contract_version: 2,
  runtime: {
    python: 'engines/cosyvoice2/.venv',
    checkpoints: 'models/tts/cosyvoice2',
    verify: { imports: [{ module: 'cosyvoice.cli.cosyvoice', class: 'CosyVoice2' }] },
  },
  call: { kind: 'python', module: 'cosyvoice.cli.cosyvoice', class: 'CosyVoice2' },
}

const EngineIdentity = loadJsx('EngineIdentity.jsx', {
  react: React,
  'web/src/lib/i18n': i18nStub,
  'useInstalled': {
    useInstalled: () => ({
      installed: [],
      loadInstalled: () => {},
      loadOne: async (id) => ({
        ok: true,
        text: JSON.stringify(PREV_MANIFEST, null, 2),
        path: 'engines/' + id + '/manifest.json',
      }),
    }),
  },
  'useEngineDirs': {
    useEngineDirs: () => ({ dirs: DIRS, reload: () => {} }),
    default: () => ({ dirs: DIRS, reload: () => {} }),
    __esModule: true,
  },
  'manifestAutoFill': require(path.join(EDITOR_DIR, 'manifestAutoFill.js')),
  // 保存走 /wizard/save，这里只验按钮的有无与可用，不真的存。
  'useSaveManifest': {
    useSaveManifest: () => ({ save: () => {}, busy: false, result: null }),
  },
}).default

/** 按文字找按钮（i18n stub 回的是英文）。 */
function buttonByText (container, text) {
  return [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text) || null
}

/** 起一个 jsdom 页面。 */
function mount () {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost:5199/',
    pretendToBeVisual: true,
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
  define('requestAnimationFrame', (cb) => setTimeout(() => cb(Date.now()), 0))
  define('cancelAnimationFrame', (id) => clearTimeout(id))
  const container = dom.window.document.getElementById('root')
  return { dom, container, root: ReactDOMClient.createRoot(container) }
}

const settle = () => new Promise((r) => setTimeout(r, 40))

// 引擎目录列表走 fetch ⇒ 在这里把它截下来。
function stubFetch (installed) {
  global.fetch = (url) => {
    if (String(url).includes('/wizard/installed')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ engines: installed }),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }
}

test('换到没名片的引擎：上一台的 runtime 与 call 整段清掉', async () => {
  stubFetch(DIRS)
  const { dom, container, root } = mount()
  let manifest = { ...PREV_MANIFEST }
  const changes = []
  root.render(React.createElement(EngineIdentity, {
    manifest,
    onChange: (m) => { manifest = m; changes.push(m) },
    facts: { env: true, models: true },
  }))
  await settle()

  const sel = container.querySelector('select')
  assert.ok(sel, '引擎下拉没渲染出来')

  // 真选一次 spark-tts（磁盘上还没名片的那台）。
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'spark-tts')
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()

  assert.ok(changes.length >= 1, '换引擎后名片没变')
  assert.strictEqual(manifest.id, 'spark-tts')
  assert.strictEqual(manifest.runtime, undefined,
    'runtime 是上一台的，整段留着就是「id 写着 spark-tts、路径却指上一台」')
  assert.strictEqual(manifest.call, undefined, 'call 是上一台的，整段留着就装着上一台的类')
  const dumped = JSON.stringify(manifest)
  assert.ok(!dumped.includes('cosyvoice'),
    '清完的名片里还有上一台的名字：' + dumped)
  assert.ok(!dumped.includes('CosyVoice'), '清完的名片里还有上一台的类名：' + dumped)
})

test('换到没名片的引擎：label 也换成新的', async () => {
  stubFetch(DIRS)
  const { dom, container, root } = mount()
  let manifest = { ...PREV_MANIFEST }
  root.render(React.createElement(EngineIdentity, {
    manifest,
    onChange: (m) => { manifest = m },
    facts: { env: true, models: true },
  }))
  await settle()

  const sel = container.querySelector('select')
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'spark-tts')
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()

  assert.strictEqual(manifest.label, 'spark-tts',
    'label 描述的是上一台，留着就是「id 是 spark-tts、label 写着上一台」')
})

test('换到磁盘上有名片的引擎：先显示「读取参数」，点了才整张换成磁盘上那张', async () => {
  stubFetch(DIRS)
  const { dom, container, root } = mount()
  let manifest = { id: 'spark-tts', label: 'spark-tts', contract_version: 2 }
  const changes = []
  root.render(React.createElement(EngineIdentity, {
    manifest,
    onChange: (m) => { manifest = m; changes.push(m) },
    facts: { env: true, models: true },
  }))
  await settle()

  const sel = container.querySelector('select')
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'cosyvoice2')
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()

  // 选中不读盘：有名片的引擎要用户点「读取参数」。
  assert.ok(!buttonByText(container, 'Scan parameters'), '有名片的引擎没读进来之前不该显示「扫描参数」')
  const read = buttonByText(container, 'Read parameters')
  assert.ok(read, '有名片的引擎应当显示「读取参数」')
  assert.ok(!container.querySelector('.wz-identity-path'), '名片还没读进来，路径不该出现')

  read.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await settle()

  assert.ok(changes.length >= 1, '读取后名片没变')
  assert.strictEqual(manifest.id, 'cosyvoice2', '磁盘上那张名片没灌进来')
  assert.strictEqual(manifest.runtime.python, 'engines/cosyvoice2/.venv',
    '磁盘上那张名片的 runtime 没灌进来')
  // 读进来之后回到「扫描参数」，路径出现，保存可用。
  assert.ok(buttonByText(container, 'Scan parameters'), '读取成功后应当回到「扫描参数」')
  const pathEl = container.querySelector('.wz-identity-path')
  assert.ok(pathEl && /engines\/cosyvoice2\/manifest\.json/.test(pathEl.textContent), '读取成功后路径应当出现')
  assert.strictEqual(buttonByText(container, 'Save').disabled, false, '读取成功后「保存」应当可点')
})

test('没名片的引擎：显示「扫描参数」，没扫过之前「保存」不可点', async () => {
  stubFetch(DIRS)
  const { dom, container, root } = mount()
  let manifest = { ...PREV_MANIFEST }
  root.render(React.createElement(EngineIdentity, {
    manifest,
    onChange: (m) => { manifest = m },
    facts: { env: true, models: true },
    onScan: () => {}, scanBusy: false, scanned: false,
  }))
  await settle()

  const sel = container.querySelector('select')
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, 'spark-tts')
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  await settle()

  assert.ok(buttonByText(container, 'Scan parameters'), '没名片的引擎应当显示「扫描参数」')
  assert.ok(!buttonByText(container, 'Read parameters'), '没名片的引擎不该有「读取参数」')
  assert.strictEqual(buttonByText(container, 'Save').disabled, true, '没扫过的新名片不该能保存')
  assert.ok(!buttonByText(container, 'Save manifest'), '按钮叫「保存」，不叫「存盘」')
})
