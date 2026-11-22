'use strict'
// 第 3 步的权重来源框真的能渲染：三个页签切换，模型仓库与文件直链
// 都把条目加进同一张清单，可一键下载全部、逐项移除。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { resolveFromRoot, esbuild } = require('../../../lib/testDeps.js')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const React = require(resolveFromRoot('react'))
const ReactDOMClient = require(resolveFromRoot('react-dom/client'))
const { JSDOM } = require(resolveFromRoot('jsdom'))
const { Simulate } = require(resolveFromRoot('react-dom/test-utils'))

function loadEsm (file) {
  const code = esbuild().transformSync(fs.readFileSync(file, 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => {
    throw new Error(path.basename(file) + ' 不该有依赖')
  }, mod)
  return mod.exports
}

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

let restoredState = null
const StepModels = loadJsx('StepsExtra.jsx', {
  react: React,
  'web/src/lib/i18n': { useT: () => ({ t: (en, zh) => zh || en, lang: 'zh' }) },
  './downloadState': { loadDownloadState: () => restoredState, saveDownloadState: () => {} },
  './downloadQueue': { DEFAULT_CONCURRENCY: 2 },
  './downloadRunner': {
    downloadFiles: async () => ({}), readSse: async () => {},
    fileSlot: (f) => `${f.kind === 'url' ? 'url' : 'repo'}|${f.kind === 'url' ? f.url : f.repo}|${f.subdir || ''}|${f.name}`,
    fileLabel: (f) => (f.subdir ? `${f.subdir}/${f.name || ''}` : (f.name || '')),
    attachDownloadProgress: () => () => {},
  },
  './downloadTask': loadEsm(path.join(EDITOR_DIR, 'downloadTask.js')),
  // 确认弹窗是主界面的共享组件，本测试只关心下载面板，不评价它。
  'components/common/Dialogs': { ConfirmDialog: () => null },
  './downloadSource': loadEsm(path.join(EDITOR_DIR, 'downloadSource.js')),
  './StepVerify': { StepVerify: () => null },
}).StepModels

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
const fetched = []
let manifestDelay = 0
define('fetch', async (url) => {
  fetched.push(String(url))
  if (String(url).includes('/wizard/download-entries')) {
    return {
      ok: true,
      json: async () => ({
        ok: true,
        entries: [],
        runtime_hints: [{ repo: 'org/hint', file: 'm.py', line: 12, call: 'from_pretrained' }],
      }),
      headers: { get: () => 'application/json' },
    }
  }
  if (String(url).includes('/wizard/download/manifest')) {
    if (manifestDelay) await new Promise((r) => setTimeout(r, manifestDelay))
    return {
      ok: true,
      json: async () => ({
        ok: true,
        files: [{ name: 'model.safetensors', size: 1000, repo: 'Org/Model-A', tool: 'hf', subdir: 'sub' }],
      }),
      headers: { get: () => 'application/json' },
    }
  }
  return {
    ok: true,
    json: async () => ({ ok: false }),
    headers: { get: () => 'application/json' },
  }
})

const container = dom.window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
// 等这一轮渲染落地。原来固定 80ms：单跑够，批量跑（多个测试文件并行）时
//   CPU 一忙就不够，断言会读到「还没重渲染」的中间态，表现为偶发失败。
//   改成轮询到元素数连续两次不变：快的时候比 80ms 还早返回，慢的时候自己等。
const settle = async () => {
  let prev = -1
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const now = container.querySelectorAll('*').length
    if (now === prev) return
    prev = now
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let seq = 0
async function show (probe = null) {
  seq += 1
  root.render(React.createElement(StepModels, {
    key: 'step' + seq,
    state: { id: 'demo', repoUrl: '' }, onChange: () => {},
    probe, prep: null, onFixId: () => {},
  }))
  await settle()
}

const inputs = () => [...container.querySelectorAll('input')]
const repoInput = () => inputs().find((i) => String(i.placeholder || '').includes('huggingface.co/org/model'))
const fileInput = () => inputs().find((i) => String(i.placeholder || '').includes('model.safetensors'))
// 手填的下载位置输入框已移除：模型仓库与文件直链都只填网址。
const destInputs = () => inputs().filter((i) => String(i.placeholder || '').includes('下载位置'))
const buttons = (text) => [...container.querySelectorAll('button')]
  .filter((b) => b.textContent.trim() === text)
const has = (text) => container.textContent.includes(text)

test('第 1 步没有探测结果时仍显示权重来源框，默认在引擎入口页签', async () => {
  await show()
  assert.ok(has('权重来源'), '三种来源要收在同一个框里')
  assert.strictEqual(buttons('引擎自带（0）').length, 1, '页签上写着引擎自带项的数量')
  assert.strictEqual(buttons('模型仓库').length, 1, '页签按钮要一直在')
  assert.strictEqual(buttons('文件直链').length, 1)
  assert.strictEqual(repoInput(), undefined, '未切页签时不渲染其它页签的输入框')
  assert.ok(!has('No probe data'), '探测缺失不该挡住手填')
  assert.strictEqual(buttons('下载未完成').length, 0, '清单为空时没有可下载条目')
})

test('模型仓库页签：两个主域名共用一个入口，没有手填下载位置框', async () => {
  await show()
  Simulate.click(buttons('模型仓库')[0])
  await settle()
  assert.ok(repoInput(), '切到页签后才出现仓库输入框')
  assert.strictEqual(destInputs().length, 0, '下载位置输入框已移除，仓库只填网址')
  Simulate.change(repoInput(), { target: { value: 'https://huggingface.co/Org/Model-A' } })
  await settle()
  Simulate.click(buttons('引入仓库')[0])
  await settle()
  assert.ok(has('已识别为 Hugging Face 仓库 Org/Model-A'))
  assert.ok(buttons('列出文件').length > 0, '加入后要出现真正的读取按钮')

  Simulate.change(repoInput(), { target: { value: 'https://www.modelscope.cn/models/iic/Demo-Model' } })
  await settle()
  Simulate.click(buttons('引入仓库')[0])
  await settle()
  assert.ok(has('魔搭 仓库 iic/Demo-Model'), '魔搭不需要另开一个控件')
})

test('文件直链页签：条目进同一张表，可一键下载全部，也可逐项移除', async () => {
  await show()
  Simulate.click(buttons('文件直链')[0])
  await settle()
  assert.strictEqual(destInputs().length, 0, '下载位置输入框已移除，直链只填网址')
  Simulate.change(fileInput(), { target: { value: 'https://example.org/weights/model.safetensors' } })
  await settle()
  Simulate.click(buttons('加入清单')[0])
  await settle()
  assert.ok(container.querySelector('table thead').textContent.includes('来源'), '表头要写明来源')
  assert.ok(container.querySelector('table tbody').textContent.includes('文件直链'), '表格要标出这一行的来源')
  assert.ok(has('model.safetensors'), '文件名从网址末段取到')
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 1)
  assert.strictEqual(buttons('下载未完成').length, 1, '只有一个下载未完成按钮')
  assert.strictEqual(buttons('移除').length, 1, '每一行都能从清单里去掉')

  Simulate.click(buttons('移除')[0])
  await settle()
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 0, '移除后这一行要真的消失')
})

test('仓库与它列出的文件在同一张表里，移除仓库时文件一起下掉', async () => {
  const probe = {
    downloader_cmds: [{ tool: 'hf', source: 'hf', repo: 'Org/Model-A', dir: 'checkpoints/sub', raw: 'hf download Org/Model-A' }],
  }
  await show(probe)
  const table = container.querySelector('table tbody')
  assert.ok(table, '探测到仓库时就要有清单表')
  assert.ok(table.textContent.includes('Org/Model-A'), '仓库行要先出现')
  assert.ok(container.querySelector('table thead').textContent.includes('来源'), '表头要写明来源')
  assert.ok(table.textContent.includes('Hugging Face'), '仓库行要标出站点来源')
  assert.ok(table.textContent.includes('尚未列出'), '还没读取时标清楚')
  assert.strictEqual(table.querySelectorAll('tr').length, 1)

  Simulate.click(buttons('列出文件')[0])
  await settle()
  const after = container.querySelector('table tbody')
  assert.strictEqual(after.querySelectorAll('tr').length, 2, '读取后文件行紧随仓库行')
  assert.ok(after.textContent.includes('model.safetensors'), '文件与仓库在同一张表')
  assert.ok(after.textContent.includes('1 个文件'), '仓库行要报出已列出的数量')
  assert.strictEqual(buttons('下载未完成').length, 1, '顶部一个「下载未完成」')
  assert.strictEqual(buttons('下载全部').length, 1, '仓库行一个「下载全部」')

  Simulate.click(buttons('-')[0])
  await settle()
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 0, '移除仓库要带走它列出的文件')
})

test('运行期资源单独列出，不混进下载清单', async () => {
  await show()
  assert.ok(has('运行期还会自行拉取'), '要有一块说明运行期资源')
  assert.ok(has('org/hint') && has('m.py:12'), '仓库与出处都要看得见')
  // 一行一条：仓库名与出处同处一行，中间有分隔符。分成两列时（定宽左列）
  //   长仓库名会横向压到右边那一串上，界面上叠成一团。
  assert.ok(has('org/hint · m.py:12'), '仓库与出处要在同一行里，不摆成两列')
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 0, '运行期资源不进清单表')
})

test('两个仓库同时列文件时，读取状态各自归属', async () => {
  manifestDelay = 150
  const probe = {
    downloader_cmds: [
      { tool: 'hf', source: 'hf', repo: 'Org/A', dir: 'checkpoints/a', raw: 'a' },
      { tool: 'hf', source: 'hf', repo: 'Org/B', dir: 'checkpoints/b', raw: 'b' },
    ],
  }
  await show(probe)
  const listButtons = () => [...container.querySelectorAll('button')]
    .filter((b) => ['列出文件', '读取中…'].includes(b.textContent.trim()))
  assert.strictEqual(listButtons().length, 2)

  Simulate.click(listButtons()[0])
  await sleep(40)
  assert.deepStrictEqual(listButtons().map((b) => b.textContent.trim()), ['读取中…', '列出文件'],
    '只有被点的那一行进入读取状态')

  await sleep(200)
  assert.deepStrictEqual(listButtons().map((b) => b.textContent.trim()), ['列出文件', '列出文件'])
  manifestDelay = 0
})

test('同一仓库两个子目录各占一行，不会被去重吃掉', async () => {
  const probe = {
    downloader_cmds: [
      { tool: 'hf', source: 'hf', repo: 'Org/A', dir: 'checkpoints/a', raw: 'a' },
      { tool: 'hf', source: 'hf', repo: 'Org/A', dir: 'checkpoints/b', raw: 'b' },
    ],
  }
  await show(probe)
  const rows = container.querySelectorAll('table tbody tr')
  assert.strictEqual(rows.length, 2, '上游命令的两个子目录是两条仓库行')
  assert.ok([...rows].every((r) => r.textContent.includes('Org/A')))
  assert.strictEqual([...container.querySelectorAll('button')]
    .filter((b) => b.textContent.trim() === '列出文件').length, 2)
})

test('刷新后恢复手填的仓库与直链条目', async () => {
  restoredState = {
    manifest: null, dedup: true,
    pastedRepos: [{ tool: 'hf', repo: 'Org/Restored', subdir: 'sub', url: 'https://huggingface.co/Org/Restored' }],
    pastedFiles: [{ kind: 'url', url: 'https://example.org/r.bin', name: 'r.bin', subdir: '', status: 'missing' }],
    removedCmds: [], removedLinks: [], sourceChoices: {},
  }
  await show()
  const table = container.querySelector('table tbody')
  assert.ok(table, '恢复出来的条目要有清单表')
  assert.ok(table.textContent.includes('Org/Restored'), '手填仓库行要回来')
  assert.ok(table.textContent.includes('r.bin'), '文件直链行要回来')
  restoredState = null
})

test('点下载后同一行立刻变成正在下载，进度长在表格行内', async () => {
  restoredState = {
    manifest: [{ name: 'model.safetensors', size: 1000, repo: 'Org/Model-A',
      tool: 'hf', subdir: '', status: 'missing' }],
    dedup: true, pastedRepos: [], pastedFiles: [],
    removedCmds: [], removedLinks: [], sourceChoices: {},
  }
  await show()
  const before = container.querySelector('table tbody tr')
  assert.ok(before, '清单要有一行文件')
  assert.ok(before.textContent.includes('model.safetensors'))
  assert.strictEqual(buttons('下载').length, 1, '未下载时给的是下载按钮')
  assert.ok(!before.textContent.includes('正在下载'), '还没点时不该报正在下载')

  Simulate.click(buttons('下载')[0])
  await settle()
  const after = container.querySelector('table tbody tr')
  const statusCell = after.children[4]
  assert.strictEqual(statusCell.textContent.trim(), '0%', '还没收到字节时显示 0%')
  assert.match(statusCell.firstElementChild.style.color, /--text/,
    '未完成时百分比是白色')
  assert.strictEqual(buttons('下载中…').length, 1, '正在下载时按钮不许重复派单')
  assert.strictEqual(buttons('下载').length, 0, '未下载的按钮要让位给新状态')
  restoredState = null
})

test('已列出的文件可以折叠，收起后只剩仓库行', async () => {
  restoredState = {
    manifest: [
      { name: 'a.bin', size: 10, repo: 'Org/Model-A', tool: 'hf', subdir: '', status: 'missing' },
      { name: 'b.bin', size: 20, repo: 'Org/Model-A', tool: 'hf', subdir: '', status: 'missing' },
    ],
    dedup: true, pastedRepos: [], pastedFiles: [],
    removedCmds: [], removedLinks: [], sourceChoices: {}, collapsedRepos: [],
  }
  const probe = {
    downloader_cmds: [{ tool: 'hf', source: 'hf', repo: 'Org/Model-A', dir: 'checkpoints', raw: 'hf download Org/Model-A' }],
  }
  await show(probe)
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 3, '仓库行加两个文件行')
  assert.strictEqual(buttons('▾').length, 1, '默认展开')

  Simulate.click(buttons('▾')[0])
  await settle()
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 1, '收起后只剩仓库行')
  assert.strictEqual(buttons('▸').length, 1, '收起后箭头要翻转')

  Simulate.click(buttons('▸')[0])
  await settle()
  assert.strictEqual(container.querySelectorAll('table tbody tr').length, 3, '再点一次要展开回来')
  restoredState = null
})
