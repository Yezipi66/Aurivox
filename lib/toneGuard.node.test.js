'use strict'
// 全项目文案语气守卫（CommonJS 侧）：扫 lib/ + tools/ + pipeline/ + server.js
// 判据（乙-严格）：口语、粗口、符号语气、破折号不许出现在任何代码行，注释里出现同样算违规。
// 豁免：测试文件本身、.bak 文件、tools/dev/ 下的开发脚本（探针与补丁，不是产品）。
// 符号说明：警告、推荐、成功三个图标作语气标记时禁，作前缀时允许；单个 — 在中文文案里禁，
// 在英文文案里允许。
// 用法：node --test lib/toneGuard.node.test.js，或 npm test（自动发现）

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// 禁词表（合并 wizard FORBIDDEN_IN_UI 17 条 + flowgraph BANNED 25 条 + 本轮新增）
const FORBIDDEN = [
  // 口语动词/口气
  '干活', '搞定', '弄好', '开跑', '跑完', '跑一遍', '跑不了', '跑之前', '试跑',
  '不用再点', '不用先点', '多半', '大概', '最可能', '其实', '反正', '随便填',
  '起来了', '没起来', '没活着回来', '被赶出来', '用到才起',
  '用到它时', '又要等', '对不上', '对不上号', '看不出来', '没什么', '拿掉', '弄坏',
  '存不进', '读不了', '存不下来', '停下来等人', '拔掉', '开工',
  '没地方', '这台机器', '没量到', '没量过', '没成功', '找不到了',
  '在跑', '没在跑', '吃多少内存', '吃到', '爆显存',
  '显存吃紧', '显存富裕', '更吃显存', '更要等', '钉语言', '边合边回',
  '免重抽', '保持热', '从库里挑', '这一块', '这一下', '那张', '才起',
  '拉回来', '画不出', '载不进来', '半截', '发糊', '发闷',
  '听着干净', '想省磁盘', '不会点亮', '用到它', '就要等', '又等',
  '先点',
  // 粗口/骂人
  '妈逼', '你妈', '吊儿郎当', '亮瞎', '作死', '扯淡', '妈的',
  // 内部原则外露
  '平台不替你猜', '平台不会替你猜', '平台不会替你选', '平台不替你挑',
  '契约里明确允许',
  '这正是这个页面存在的理由',
  // 符号语气（作语气标记用）
  '⛔', '⭐', '✅',
  // 破折号
  '——',
]

// 单个 em dash：只在伴随中文时禁（英文文案里 — 是正确的）
const EM_DASH_WITH_CHINESE = /[\u4e00-\u9fff]\s*—\s*[\u4e00-\u9fff]/

// 扫描范围。目录由 walk() 逐个递归。
const SCAN_DIRS = [
  path.join(ROOT, 'lib'),
  path.join(ROOT, 'tools', 'cli'),
  path.join(ROOT, 'tools', 'build'),
  path.join(ROOT, 'tools', 'deploy'),
  path.join(ROOT, 'tools', 'engine-wizard'),
  path.join(ROOT, 'pipeline'),
]

// 文件：根目录下的单文件。walk() 只处理目录，这类要单独列出来，否则「加了一个文件」
// 在守卫里看不见。
const SCAN_FILES = [
  path.join(ROOT, 'server.js'),
]

// 豁免：测试文件、.bak、tools/dev/
function isExcluded (rel) {
  if (/\.test\./.test(rel)) return true
  if (/\.bak$/.test(rel)) return true
  if (rel.startsWith('tools' + path.sep + 'dev' + path.sep)) return true
  if (rel.startsWith('lib' + path.sep + '__testsupport__' + path.sep)) return true
  return false
}

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(js|jsx|mjs|cjs|py)$/.test(e.name)) out.push(p)
  }
  return out
}

const files = []
for (const d of SCAN_DIRS) {
  if (fs.existsSync(d)) walk(d, files)
}
// 根目录下的单文件：不走 walk()，直接加进来（它自己不是目录）。
for (const f of SCAN_FILES) {
  if (fs.existsSync(f)) files.push(f)
}

test('⛔ 全项目文案语气守卫（lib/ + tools/ + pipeline/ + server.js）：口语/粗口/符号语气/破折号 不许出现在任何代码行', () => {
  const bad = []
  for (const f of files) {
    const rel = path.relative(ROOT, f)
    if (isExcluded(rel)) continue
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const w of FORBIDDEN) {
        if (line.includes(w)) {
          bad.push(`${rel}:${i + 1}  [${w}]  ${line.trim().slice(0, 90)}`)
          break
        }
      }
      if (EM_DASH_WITH_CHINESE.test(line)) {
        bad.push(`${rel}:${i + 1}  [em dash 伴随中文]  ${line.trim().slice(0, 90)}`)
      }
    })
  }
  assert.deepEqual(bad, [],
    `\n有 ${bad.length} 处口语/粗口/符号语气/破折号：\n  ${bad.join('\n  ')}`)
})

test('守卫自身有效（禁词表非空、扫描文件数 > 0）', () => {
  assert.ok(FORBIDDEN.length >= 50, `禁词表只有 ${FORBIDDEN.length} 条，应 >= 50`)
  assert.ok(files.length > 50, `只扫到 ${files.length} 个文件，应 > 50`)
})

// 扫描范围自证：扩进来的目录与文件必须真的在扫。
// 只断言「文件数 > 0」证明不了范围对：把 SCAN_DIRS 写错成别的目录，文件数照样很大，
// 守卫照样全绿，扩范围这件事等于没做。这里逐个点名：每个扩进来的都要有文件被扫到。
test('扩进来的扫描范围必须真的被扫到（tools/build、tools/deploy、tools/engine-wizard、pipeline、server.js）', () => {
  const scanned = new Set(files.map((f) => path.relative(ROOT, f).split(path.sep).join('/')))
  const wanted = [
    'tools/build/',
    'tools/deploy/',
    'tools/engine-wizard/',
    'pipeline/',
    'server.js',
  ]
  const missing = wanted.filter((w) => {
    if (w.endsWith('/')) {
      return ![...scanned].some((s) => s.startsWith(w))
    }
    return !scanned.has(w)
  })
  assert.deepEqual(missing, [],
    `\n这些范围没有被扫到：\n  ${missing.join('\n  ')}\n`
    + '  扩了范围但没扫到 = 扩范围这件事没做（守卫还是原来那个）。')
})
