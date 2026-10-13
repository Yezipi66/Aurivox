// ============================================================================
//  全项目文案语气守卫（ESM 侧）—— 扫 web/src/
// ============================================================================
//
// 为什么需要它：
//   项目已有两套禁词表但各管一块（wizard 一套、flowgraph 一套），
//   web/src 主体没有守卫。改完口语后没有守卫，下次又会漂回去。
//   这条守卫把两套表合并成一份全项目通用判据，扫描范围扩到整个 web/src/。
//
// 判据（乙-严格）：
//   口语/粗口/符号语气/破折号 **不允许出现在任何代码行（包括注释）**。
//   注释里出现这些词（如「这条守卫在防『干活』」）也算违规 —— 注释也应保持专业。
//
// 豁免：
//   - 测试文件本身（*.test.js / *.node.test.js）
//   - .bak 文件
//   - tools/dev/ 下的开发脚本（探针/补丁，不是产品）
//
// 符号说明：
//   - ⛔/⭐/✅ 作语气标记 → 禁
//   - ⚠ 作警告图标前缀 → 允许
//   - ★ 作推荐标记 → 允许
//   - 单个 — 在中文文案里 → 禁；在英文文案里 → 允许
//
// 用法：
//   node --test web/src/toneGuard.node.test.js
//   或 npm test（自动发现）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// 禁词表（合并 wizard FORBIDDEN_IN_UI 17 条 + flowgraph BANNED 25 条 + 本轮新增）
// ---------------------------------------------------------------------------
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
  '平台不替你猜', '平台不会替你猜', '平台不会替你选',
  '契约里明确允许',
  '这正是这个页面存在的理由',
  // 符号语气（作语气标记用）
  '⛔', '⭐', '✅',
  // 破折号
  '——',
]

// 单个 em dash：只在伴随中文时禁（英文文案里 — 是正确的）
const EM_DASH_WITH_CHINESE = /[\u4e00-\u9fff]\s*—\s*[\u4e00-\u9fff]/

// ---------------------------------------------------------------------------
// 扫描范围
// ---------------------------------------------------------------------------
const SCAN_DIR = path.join(ROOT, 'web', 'src')

function isExcluded (rel) {
  if (/\.test\./.test(rel)) return true
  if (/\.bak$/.test(rel)) return true
  if (rel.startsWith('..' + path.sep + 'tools' + path.sep + 'dev' + path.sep)) return true
  return false
}

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(jsx?|mjs|cjs)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

const files = fs.existsSync(SCAN_DIR) ? walk(SCAN_DIR) : []

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------
test('⛔ 全项目文案语气守卫（web/src/）：口语/粗口/符号语气/破折号 不许出现在任何代码行', () => {
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
