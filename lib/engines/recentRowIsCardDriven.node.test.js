'use strict'

// 守卫：历史记录那一行，从写盘到显示一共四处，⛔ 一处都不许再写死位名。
//
// 病历（Owner 2026-08-31 00:42 真机）：一条 IndexTTS2 的记录印着
//     Base model · Auto · GPT - / SoVITS - · ref 交谈2_2.wav · seed 3788417817
//
// 为什么必须是**四处一起**：同一句话当年被抄了四遍。只改其中一处的症状是
// 「改完还是老样子」——
//     lib/services/synthesisService.js   写 meta（普通生成）
//     lib/routes/synthesis.js            写 meta（broker 流式 + 非流式）
//     server.js  genItemFromMeta         读 meta 时又写死一遍位名
//     web/.../GenerateTab.jsx            最后那句模板
// 我第一次找到的只有前两处；漏掉 genItemFromMeta 的话，后端存对了，
// 前端拿到的还是两个横杠。
//
// ⚠ 这是**文本守卫**，不是行为守卫 —— 行为那一半在
//   lib/engines/weightSummary.node.test.js 和 synthesisService.nails 里。
//   文本守卫在这里是有价值的：这个 bug 的形态就是"代码里多了一个位名"，
//   而它在单元测试里表现为全绿（假名片刚好也有那两个位）。
//
// ⛔ 只看**代码行**，注释里点名必须允许：这几个文件的注释正是在讲这段病历，
//   连讲都不让讲，下一个人就只能重犯一次。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')

/** 去掉整行注释（// 与块注释的续行）。行尾注释保留 —— 宁可误报也不漏报。 */
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释（含 jsx 的 {/* … */}），整块剥掉
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l)) // 整行 // 注释
    .join('\n')
}

function sliceFunction(src, header) {
  const i = src.indexOf(header)
  assert.notEqual(i, -1, `找不到 ${header} —— 这条守卫盯的东西被改名了，请改守卫，⛔ 不要删`)
  const rest = src.slice(i)
  const end = rest.indexOf('\n}\n')
  return rest.slice(0, end < 0 ? rest.length : end)
}

// 被禁的是**位名**，不是引擎 id：引擎 id 会以数据形式出现在别处（比如
// 名片目录名），而位名一旦出现在平台代码里，就一定是某台引擎的私有知识。
const SLOT_WORDS = ['gpt', 'sovits']

test('⛔⛔ server.js 的 genItemFromMeta 不许提任何位名', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
  const fn = codeOnly(sliceFunction(src, 'function genItemFromMeta'))
  for (const w of SLOT_WORDS) {
    assert.ok(!fn.toLowerCase().includes(w),
      `genItemFromMeta 里出现了 "${w}" —— 读回来的时候又把第一台引擎的位表抄了一遍。` +
      '这一处是最容易漏的：上游三处都改对了，它一个人就能把「GPT - / SoVITS -」变回来。')
  }
})

test('⛔⛔ 前端历史记录那一行不许提任何位名', () => {
  const p = path.join(ROOT, 'web', 'src', 'components', 'generate', 'GenerateTab.jsx')
  const src = fs.readFileSync(p, 'utf8')
  // 只截 Recent Generations 那一段（这个文件别处还在跟 GSV 的参数名打交道，
  // 那是另外的账，不在这条守卫的题目里）。
  const i = src.indexOf('recent.map(item =>')
  assert.notEqual(i, -1, '找不到历史记录的渲染循环 —— 请改守卫，⛔ 不要删')
  // 收在这一行的按钮组之前：再往后就是别的组件，那里今天仍然按 GSV 长
  // （VoiceSidebar 的注释里就有 SoVITS），不是这条守卫的题目。
  const j = src.indexOf('rr-actions', i)
  assert.ok(j > i, '找不到历史记录行的结尾 —— 请改守卫，⛔ 不要删')
  const block = codeOnly(src.slice(i, j))
  for (const w of SLOT_WORDS) {
    assert.ok(!block.toLowerCase().includes(w),
      `历史记录那一行里出现了 "${w}" —— 这正是 Owner 看到的那两个横杠的出处。` +
      '这一行必须整段交给 describeGeneration()，位名由名片说。')
  }
  assert.ok(block.includes('describeGeneration('),
    '这一行必须走 describeGeneration()')
})

/** 截出「交给 writeGenMeta 的那个对象字面量」。⛔ 不扫整份文件：
 *  cfg 那一层今天仍然逐个列着 GSV 的参数名（gpt_model / top_k / …），那是
 *  另外一笔还没还的账（legacyDefault / buildTtsPayload）。这条守卫只管一件事：
 *  **那笔账不许再往 meta.json 上蔓延**。尺子对不准题目，守卫就会变成噪音，
 *  然后被人关掉。 */
function metaLiterals(src) {
  const out = []
  const re = /(const metaBase = \{|writeGenMeta\(\s*genId\s*,\s*\{)/g
  let m
  while ((m = re.exec(src)) !== null) {
    // 从这个 `{` 开始括号计数，取到配平为止。
    let depth = 0
    let i = src.indexOf('{', m.index)
    const start = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) break }
    }
    out.push(src.slice(start, i + 1))
  }
  return out
}

test('⛔⛔ 三处写 meta 的地方，都不许再往 meta 上挂位名字段', () => {
  const files = [
    path.join(ROOT, 'lib', 'services', 'synthesisService.js'),
    path.join(ROOT, 'lib', 'routes', 'synthesis.js'),
  ]
  let checked = 0
  let withWeights = 0
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
    const blocks = metaLiterals(src)
    assert.ok(blocks.length, `${path.relative(ROOT, f)} 里一处写 meta 的地方都没找到 —— ` +
      '要么被改名了（请改守卫），要么这条守卫其实什么都没在看')
    for (const b of blocks) {
      checked++
      const code = codeOnly(b)
      for (const w of SLOT_WORDS) {
        const re = new RegExp(`\\b${w}(_model)?\\s*:`, 'i')
        const m2 = code.match(re)
        assert.ok(!m2, `${path.relative(ROOT, f)} 的 meta 里还有 "${m2 && m2[0]}" 这个键 —— ` +
          '位表走 weightSummary(engine.weight_slots, cfg)')
      }
      // 摊开 metaBase 的那几处不必自己带 weights —— 它们继承。
      if (!code.includes('...metaBase')) {
        assert.ok(/weights:\s*weightSummary\(/.test(code),
          `${path.relative(ROOT, f)} 有一处写 meta 没带 weights —— 那条记录在界面上会没有模型这一段`)
        withWeights++
      }
    }
  }
  assert.ok(checked >= 3, '一处都没扫到就等于没守卫')
  assert.equal(withWeights, 3, '自己算 weights 的就是三处（metaBase + broker 流式 + 非流式）；' +
    '数目变了说明抄出了第四处，或者少了一处')
})

test('⭐ 反面：把守卫自己验一遍（改坏了它必须会红）', () => {
  // 这条测的是上面那三条的**尺子**，不是被测物：一个文本守卫最常见的坏法
  // 是正则写歪了、对什么都返回"干净"，于是它永远绿。
  const bad = 'writeGenMeta(id, {\n  gpt: baseName(cfg.gpt_model) || "-",\n})'
  assert.ok(/\bgpt(_model)?\s*:/i.test(codeOnly(bad)), '尺子对已知的坏样本必须报警')
  const good = 'writeGenMeta(id, {\n  weights: weightSummary(engine.weight_slots, cfg),\n})'
  assert.ok(!/\bgpt(_model)?\s*:/i.test(codeOnly(good)), '尺子对已知的好样本不许误报')
  // 注释里点名必须放行 —— 否则病历就写不了了。
  const commented = '// 这里以前是 gpt: cfg.gpt_model\nweights: [],'
  assert.ok(!/\bgpt(_model)?\s*:/i.test(codeOnly(commented)), '整行注释必须被剥掉')
})
