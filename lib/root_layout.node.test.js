'use strict'

// ---------------------------------------------------------------------------
//  根目录布局守卫（r12c batch13）
// ---------------------------------------------------------------------------
// 根目录是最容易腻掉的地方：每次排查都会落一个探针、每次改动都会
// 落一个补丁，积到一定程度就看不出哪些是产品、哪些是垃圾。
// 让测试盯着，不靠记性。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const P = require('./paths')

const ROOT = P.APP_DIR

// ---------------------------------------------------------------------------
//  准入表 = docs/ROOT_LAYOUT.md，不是这个文件
// ---------------------------------------------------------------------------
// batch13 的第一版守卫是**反过来**写的：列出坏名字的形状
// （apply-* / probe_* / collect_* / sources_*.zip）去抓。
// 2026-08-20 当场失效一次 —— 助手换了个 precheck_ 前缀，守卫一声没响，
// 读数仍是「助手产出物：无 ✅」。**按坏名字认目标 = 只抓我想得到的那几种。**
//
// 改成反向白名单：根目录只允许出现准入表里登记过的条目，多出来的一律红。
// 准入表写在 docs/ROOT_LAYOUT.md（一张 Markdown 表），因为它要给人读；
// 这里只负责解析它。**新增根目录条目的唯一途径是去那张表里登记并写明理由。**

const LAYOUT_DOC = path.join(ROOT, 'docs', 'ROOT_LAYOUT.md')

function parseRootLayout(md) {
  // | `名字` | 类型 | 归属 / 判据 | 必须存在 |
  const rows = []
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 6) continue
    const m = cells[1].match(/^`([^`]+)`$/)
    if (!m) continue
    rows.push({ name: m[1], kind: cells[2], why: cells[3], must: cells[4] === '是' })
  }
  return rows
}

test('根目录准入表本身可解析（防守卫恒真）', () => {
  assert.ok(fs.existsSync(LAYOUT_DOC),
    'docs/ROOT_LAYOUT.md 不在盘上 —— 准入表没了，下面那条守卫会变成恒真')
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  assert.ok(rows.length >= 20,
    `准入表只解析出 ${rows.length} 条 —— 表格写法多半变了，` +
    '解析不到会让「根目录很干净」和「根本没检查」读数相同')
  for (const anchor of ['server.js', 'lib', 'engines', 'package.json']) {
    assert.ok(rows.some((r) => r.name === anchor),
      `准入表里没有 ${anchor} —— 解析结果不可信`)
  }
})

test('根目录只允许出现准入表登记过的条目', () => {
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  const allowed = new Set(rows.map((r) => r.name))
  const offenders = fs.readdirSync(ROOT).filter((n) => !allowed.has(n))
  assert.deepEqual(offenders, [],
    `项目根出现未登记条目：${offenders.join('、')} —— ` +
    '要么把它放到该去的地方（助手产出物归 tools/dev/、缓存归 cache/），' +
    '要么去 docs/ROOT_LAYOUT.md 登记并写明「它是什么、丢了会怎样」。' +
    '不写理由的登记等于没有规则')
})

test('准入表里标了「必须存在」的条目必须真在盘上（防表烂掉）', () => {
  const rows = parseRootLayout(fs.readFileSync(LAYOUT_DOC, 'utf8'))
  const missing = rows.filter((r) => r.must && !fs.existsSync(path.join(ROOT, r.name)))
  assert.deepEqual(missing.map((r) => r.name), [],
    '准入表登记了但盘上没有的条目 —— 清单腐烂成「加进去就不红」的垃圾场了')
})

test('根目录不得残留 .bak', () => {
  const offenders = fs.readdirSync(ROOT).filter((n) => n.endsWith('.bak'))
  assert.deepEqual(offenders, [],
    `项目根残留补丁备份：${offenders.join('、')} —— ` +
    '确认不再回滚后归档到 cache/patch-backup/。' +
    '留在根目录会被当成活代码读，读了就会照错的改')
})

test('numba 缓存不得再落在项目根', () => {
  // 落点权威是 lib/paths.js 的 CACHE.numba。infer_server.py 曾经自己硬编码
  // PROJECT_ROOT/.numba_cache，而它是 start.ps1 直接拉起的，不经过 python_helper。
  assert.ok(!fs.existsSync(path.join(ROOT, '.numba_cache')),
    '项目根又出现了 .numba_cache/ —— 有人绕过了 lib/paths.js 的 CACHE.numba，' +
    '去查谁在 setdefault("NUMBA_CACHE_DIR", ...) 里写了自己的落点')
})

test('dump_tree.ps1 引用的目录必须存在（防诊断工具静默失明）', (t) => {
  // 自伤 #17：batch12 把这个脚本改成引用已不存在的 vendor\\uvr5。
  // Dump-Tree 对不存在的目录**不报错、只输出空**，于是
  // 「这棵树是空的」和「这棵树根本没扫」读数一模一样。
  const ps1 = path.join(ROOT, 'tools', 'scripts', 'dump_tree.ps1')
  if (!fs.existsSync(ps1)) {
    t.skip('tools/scripts/dump_tree.ps1 不在盘上')
    return
  }
  const src = fs.readFileSync(ps1, 'utf8')
  const re = /Dump-Tree \(Join-Path \$root '([^']+)'\)\s*'([^']*)'/g
  const missing = []
  let m
  let seen = 0
  while ((m = re.exec(src)) !== null) {
    seen += 1
    const rel = m[1]
    const label = m[2]
    // 标了 (if any) 的是可选目录，不在盘上是正常的。
    if (label.includes('if any')) continue
    const full = path.join(ROOT, rel.split('\\').join(path.sep))
    if (!fs.existsSync(full)) missing.push(rel)
  }
  assert.ok(seen > 0, 'dump_tree.ps1 里一条 Dump-Tree 调用都没解析出来 —— ' +
    '正则跟脚本写法对不上了，这条断言已经变成恒真')
  assert.deepEqual(missing, [],
    `dump_tree.ps1 引用了不存在的目录：${missing.join('、')} —— ` +
    '它是认识盘面的诊断工具，引用失准时输出看起来只是「那里是空的」')
})
