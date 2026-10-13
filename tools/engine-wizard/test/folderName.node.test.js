'use strict'
// ============================================================================
//  目录名单源化 —— folderName
//
//  ⚠ 这份测试守护的 bug（Owner 2026-10-13 真机抓到）：
//    同一屏出现**两个不同的 id** ——
//      「克隆到本地的 engines/<新名字>」（文案用输入框里的值）
//      「engines/<旧名字>/ already has 25 item(s)」（克隆请求用 localStorage 里的旧值）
//    根因：克隆请求体写的是 `id: idInput || state.id`，输入框一空就退化到
//    state.id，而它是上次安装遗留在持久段里的旧 id。
//
//  判据：目录名的唯一来源 = 输入框 + 仓库名。
//        ⛔ 持久段里的旧 id 不是来源 —— 它只在解析/克隆成功后由响应写回。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

const FOLDER_NAME = path.join(__dirname, '..', 'editor', 'folderName.js')

let folderName
test('⏳ 加载 folderName.js', async () => {
  const m = await import(pathToFileURL(FOLDER_NAME).href)
  folderName = m.folderName
  assert.strictEqual(typeof folderName, 'function')
})

// ---------------------------------------------------------------------------
// ① 优先级：输入框里敲的赢
// ---------------------------------------------------------------------------
test('⭐ 输入框有值就用输入框的（⛔ 不让仓库名把它盖掉）', () => {
  assert.strictEqual(folderName({ typed: 'my-name', suggested: 'repo-name' }), 'my-name')
})

test('⭐ 输入框留空才用仓库名（这是「填空预览」那条老行为）', () => {
  assert.strictEqual(folderName({ typed: '', suggested: 'repo-name' }), 'repo-name')
  assert.strictEqual(folderName({ typed: undefined, suggested: 'repo-name' }), 'repo-name')
})

test('⭐ 两端都空 ⇒ 空串（调用方必须拦住，⛔ 不许拿别的值顶）', () => {
  assert.strictEqual(folderName({ typed: '', suggested: '' }), '')
  assert.strictEqual(folderName({}), '')
  assert.strictEqual(folderName(), '')
  assert.strictEqual(folderName({ typed: '   ', suggested: null }), '')
})

test('⭐ 两端都有空白 ⇒ 一律 trim', () => {
  assert.strictEqual(folderName({ typed: '  a  ', suggested: 'b' }), 'a')
  assert.strictEqual(folderName({ typed: '\t\n', suggested: '  b  ' }), 'b')
})

// ---------------------------------------------------------------------------
// ② ⭐⭐ 核心护栏：**旧持久 id 不是来源**
// ---------------------------------------------------------------------------
// 真机那个双 id bug 的判据：输入框为空时，结果只许落到「仓库名」上，
// ⛔ 不许落到任何第三个来源上。签名里没有那个位 ⇒ 这条由源码形状守着。
test('⛔⛔ 签名里没有「旧 id / persistedId / fallback」这一位', () => {
  const src = require('node:fs').readFileSync(FOLDER_NAME, 'utf8')
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // 形参只许 typed / suggested 两件事
  const sig = /folderName\s*\(([^)]*)\)/.exec(src)
  assert.ok(sig, '找不到 folderName 的签名')
  const params = (sig[1].match(/\w+/g) || []).filter((w) => w !== 'src')
  assert.deepStrictEqual(params, ['typed', 'suggested'],
    `签名多出来源了：${params.join(', ')} —— 加第三个来源就是再漂一次`)
  // 实现里不许冒出一个「拿持久段旧 id」的引用
  assert.ok(!/state\.id|persistedId|localStorage/.test(code),
    'folderName 不许去读持久段/父组件 state —— 那样旧 id 又回到计算链里')
})

// ---------------------------------------------------------------------------
// ③ 三处必须同值：克隆请求 / 命令文案 / 目标路径
// ---------------------------------------------------------------------------
// 「同一份 id 喂四处」这件事在 UI 层由 curId 一个变量驱动；这里钉住的是
// 那个变量**能**只由一个值驱动：任何人改目录名，四处都取同一个结果。
test('⛔ 命令、目标路径、风险文案三处必须拿到同一个值', () => {
  const typed = 'abc'
  const suggested = 'abc'
  const curId = folderName({ typed, suggested })
  // 模拟 StepPrepare.jsx 里那三处拼接（⛔ 不许各自再降级一次）
  const command = `git clone https://x/y.git engines/${curId}`
  const target = `engines/${curId}/`
  const riskPath = `engines/${curId}`
  assert.strictEqual(command, 'git clone https://x/y.git engines/abc')
  assert.strictEqual(target, 'engines/abc/')
  assert.strictEqual(riskPath, 'engines/abc')
})

test('⛔ 输入框被清空时命令与目标必须一起变（不许停在旧值）', () => {
  const before = folderName({ typed: 'old-name', suggested: 'old-name' })
  const after = folderName({ typed: '', suggested: 'old-name' })
  assert.strictEqual(before, after, '清空输入框 ⇒ 目录名回到仓库名，⛔ 不是别的值')
})

// ---------------------------------------------------------------------------
// ④ 纪律
// ---------------------------------------------------------------------------
test('⛔ folderName.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = require('node:fs').readFileSync(FOLDER_NAME, 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('⛔ folderName.js 里不许出现引擎目录写法', () => {
  const src = require('node:fs').readFileSync(FOLDER_NAME, 'utf8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(!/engines\//.test(code), '路径拼接归 clone.js，⛔ 前端不算路径')
})
