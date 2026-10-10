'use strict'
// ============================================================================
//  ⭐ 样式守卫 —— ⛔ 向导不许重定义项目已有的类
//
//  ⚠ 这份测试存在的理由（2026-10-04 实测）：
//   editor.css 一度重复定义了 9 个项目已有的类：
//     .pipe-map / .pipe-step / .pipe-dot / .pipe-seg
//     .expert-block / .expert-summary / .expert-warning
//     .expert-unlock / .expert-fields
//   而 editor 又 import 了 web/src/styles.css
//   ⇒ 同名不同义 + 同时加载 ⇒ **谁生效取决于 import 顺序**。
//   那不是「不规范」，是渲染结果不确定。
//
//  ⛔ 同理：不许重画项目已有的容器。
//   项目的规范形状是 section 三件套 / collapsible / field / msg /
//   form-grid / param-grid / workspace-container（居中）。
//   向导自己再写一套同形状的，就是两套事实。
// ============================================================================

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const WIZ = path.join(__dirname, '..', 'editor')
const PROJECT_CSS = path.join(__dirname, '..', '..', '..', 'web', 'src', 'styles.css')
const WIZ_CSS = path.join(WIZ, 'editor.css')

const proj = fs.readFileSync(PROJECT_CSS, 'utf8')
const wiz = fs.readFileSync(WIZ_CSS, 'utf8')

/** 项目 styles.css 里定义的顶层类 */
function projectClasses (css) {
  const out = new Set()
  for (const m of css.matchAll(/^\.([a-z][a-z0-9_-]*)/gm)) out.add(m[1])
  return out
}

/** 向导 editor.css 里定义的顶层类（⛔ 不含嵌套选择器的后半段） */
function wizardClasses (css) {
  const out = new Set()
  for (const line of css.split('\n')) {
    const m = line.match(/^(\.[a-z][a-z0-9_ -]*)\s*[,{]/)
    if (m) for (const c of m[1].split(/\s+/)) if (c.startsWith('.')) out.add(c.slice(1))
  }
  return out
}

// ---------------------------------------------------------------------------
// ⭐ P0：同名冲突
// ---------------------------------------------------------------------------
test('⭐ ⛔ editor.css 不许定义项目已有的类（同名不同义 = 渲染看 import 顺序）', () => {
  const p = projectClasses(proj)
  const w = wizardClasses(wiz)
  const clash = [...w].filter((c) => p.has(c)).sort()
  assert.deepStrictEqual(clash, [],
    `⛔ 与项目重名 ${clash.length} 个：${clash.join(', ')}\n`
    + '   editor 又 import 了 styles.css ⇒ 同名不同义时谁生效取决于 import 顺序。\n'
    + '   解法：删掉本文件的定义，用项目那份（TrainingTab 就是这么用的）。')
})

test('⭐ ⭐ 点名那 9 个曾经重名的（回归守卫）', () => {
  const ONCE_DUP = ['pipe-map', 'pipe-step', 'pipe-dot', 'pipe-seg',
    'expert-block', 'expert-summary', 'expert-warning',
    'expert-unlock', 'expert-fields']
  const defined = wizardClasses(wiz)
  const back = ONCE_DUP.filter((c) => defined.has(c))
  assert.deepStrictEqual(back, [],
    `⛔ 这 9 个又回来了：${back.join(', ')} —— `
    + '它们是 TrainingTab 在用的那套，向导必须用项目那份')
})

// ---------------------------------------------------------------------------
// P1：不许重画已有容器
// ---------------------------------------------------------------------------
test('⭐ ⛔ 向导必须用项目的容器类，不能自己造同形状的', () => {
  // 这些是项目的规范容器，向导的 JSX 里应该出现
  const src = fs.readdirSync(WIZ)
    .filter((f) => f.endsWith('.jsx'))
    .map((f) => fs.readFileSync(path.join(WIZ, f), 'utf8'))
    .join('\n')

  // ① 分段三件套
  assert.ok(src.includes('className="section"'), '⛔ 没有用项目的 .section 分段')
  assert.ok(/className="[^"]*\bsection-hdr\b/.test(src), '⛔ 没有 .section-hdr')
  assert.ok(/className="[^"]*\bsection-body\b/.test(src), '⛔ 没有 .section-body')

  // ② 居中容器（项目：max-width:1400px; margin:0 auto）
  assert.ok(src.includes('workspace-container'),
    '⛔ 没有用项目的 .workspace-container（居中容器）')

  // ③ ⛔ 不许有自造的 mf-section（section 的同形状替代品）
  assert.ok(!/className="[^"]*\bmf-section\b/.test(src),
    '⛔ 还有 mf-section —— 那是重画项目 .section')
})

test('⭐ ⛔ 不许出现项目的 --radius 之外的圆角写法', () => {
  // 项目用 var(--radius-sm/md/lg)；裸 px 圆角 = 自创尺度
  const bare = [...wiz.matchAll(/border-radius:\s*([0-9]+)px/g)].map((m) => m[1])
  assert.deepStrictEqual(bare, [],
    `⛔ 有 ${bare.length} 处裸 px 圆角：${[...new Set(bare)].join(', ')} —— `
    + '项目用 var(--radius-sm/md/lg)，跟着它走')
})

test('⭐ ⛔ 不许手抄语义色的 rgba 常量（项目 --danger/--warning/--info/--success 已在用）', () => {
  // 项目的 .msg-info 就是这么写的：rgba(100,181,246,0.1) ⇒ 允许这一组
  const KNOWN = new Set(['rgba(100,181,246,0.1)', 'rgba(207,102,121,0.14)',
    'rgba(76,175,80,0.1)'])
  const m = [...wiz.matchAll(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*[\d.]+\s*\)/g)]
    .map((x) => x[0].replace(/\s+/g, ''))
  const odd = [...new Set(m)].filter((x) => !KNOWN.has(x))
  // 允许 opacity 变体（.1 / .14），⛔ 但透明度不能是我发明的第三种
  const badAlpha = [...new Set(m)]
    .map((x) => (x.match(/,([\d.]+)\)$/) || [])[1])
    .filter((a) => a && !['0.1', '0.14'].includes(a))
  assert.deepStrictEqual(badAlpha, [],
    `⛔ 出现了第三种透明度：${badAlpha.join(', ')} —— `
    + '项目的 .msg-* 只用 0.1 和 0.14')
})

// ---------------------------------------------------------------------------
// P2：字号阶梯不许自创
// ---------------------------------------------------------------------------
test('⭐ ⛔ 向导的字号不许超出项目的阶梯', () => {
  // 项目的实际字号（styles.css + TrainingTab）：10 / 11 / 12 / 13 / 14
  const ALLOWED = new Set(['10', '11', '12', '13', '14', 'inherit'])
  const bad = [...wiz.matchAll(/font-size:\s*([0-9]+)px/g)]
    .map((m) => m[1])
    .filter((v) => !ALLOWED.has(v))
  assert.deepStrictEqual([...new Set(bad)], [],
    `⛔ 出现了阶梯外的字号：${[...new Set(bad)].join(', ')} —— `
    + "项目只用 10/11/12/13/14（.field-hint 10px / .msg 12px / .collapsible-hdr 13px…）")
})

// ---------------------------------------------------------------------------
// 纪律：色板不散落
// ---------------------------------------------------------------------------
test('⭐ 向导只用项目的 CSS 变量，不写死颜色字面量', () => {
  const hex = [...wiz.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  assert.deepStrictEqual([...new Set(hex)], [],
    `⛔ 有 ${hex.length} 个写死的颜色：${[...new Set(hex)].slice(0, 5).join(', ')} —— `
    + '全部走 var(--text)/var(--muted)/var(--border)/var(--danger) 等')
})

test('⛔ editor.css 头部必须写清「三条纪律」', () => {
  const head = wiz.split('\n').slice(0, 40).join('\n')
  assert.ok(head.includes('不重定义') || head.includes('不许定义'),
    '⛔ 文件头没写「不重定义项目已有的类」这条纪律')
})
// ---------------------------------------------------------------------------
// ⭐ useT() 解构守卫 —— 2026-10-04 今晚犯了 4 次同一个错
// ---------------------------------------------------------------------------
test('⭐ ⛔ 用了 lang/t/setLang 就必须从 useT() 解构出来', () => {
  const dir = path.join(__dirname, '..', 'editor')
  const bad = []
  for (const f of fs.readdirSync(dir).filter((x) => /\.jsx?$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    // 真的在用 lang（比较/取值），⛔ 不是出现在注释里
    const uses = /[^\w.]lang\s*===|\{lang\b|\blang\s*&&/.test(
      src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))
    if (!uses) continue
    const has = /const\s*\{[^}]*\blang\b[^}]*\}\s*=\s*useT\(\s*\)/.test(src)
    if (!has) bad.push(f)
  }
  assert.deepStrictEqual(bad, [],
    `⛔ 这些组件用了 lang 但没从 useT() 解构：${bad.join(', ')}\n`
    + '   症状是运行时 ReferenceError（⛔ 编译期查不出来），整页白屏。\n'
    + '   useT() 返回的是对象 {lang, setLang, t}，⛔ 不是函数。')
})

test('⭐ ⛔ 禁止把 useT() 当函数调用（useT()(...)）', () => {
  const dir = path.join(__dirname, '..', 'editor')
  for (const f of fs.readdirSync(dir).filter((x) => /\.jsx?$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/useT\(\)\s*\(/.test(code),
      `${f}: 把 useT() 当函数调了（useT() 返回的是对象，不是函数）`)
    // ⛔ 解构出来的 t 必须被当**函数**用（t('en','zh')），而不是当对象
    const destr = /const\s*\{([^}]*)\}\s*=\s*useT\(\)/.exec(code)
    if (destr && /\bt\b/.test(destr[1])) {
      assert.ok(/\bt\s*\(/.test(code),
        `${f}: 解构了 t，却从来没有 t(...) 调用 —— 多半把它当对象用了`)
    }
  }
})

// ---------------------------------------------------------------------------
// ⭐ P0-补：具体引擎名 —— ⛔ 连注释和测试都不许出现
//
// ⚠ 为什么要全局一条（2026-10-05）：
//   每个文件自己的守卫只查自己那一个文件（resolve.node.test.js 的
//   「本文件不许出现具体引擎名」查不到 probe.node.test.js 里的）。
//   ⇒ 实测 test/resolve.node.test.js 里躺着 33 处 OpenBMB/VoxCPM，
//     而 186 条测试**全绿** —— 守卫有洞，纪律就等于没有。
// ⛔ 规则：向导是给**任意**上游用的，装谁都得能用。
//   提一个具体引擎的名字，就等于把那个引擎写进了通用工具。
// ---------------------------------------------------------------------------
// ⭐ 已知引擎名清单 —— ⛔ 这份表本身就写着这些名字，
//   所以扫描时必须跳过「只是在列举它们」的那几行（否则自己告自己）。
const ENGINE_NAMES = [
  'voxcpm', 'gpt-sovits', 'gpt_sovits', 'sovits',
  'indextts', 'cosyvoice', 'fish-speech', 'fish_speech',
  'f5-tts', 'emoji-tts', 'emojitts',
]
// ⛔ 本文件里「就是在列举这些名字」的行（清单本身 + 这条测试的注释）
const SELF_RE = /ENGINE_NAMES|具体引擎名/

test('⛔⛔ ⭐ 向导的**活代码**不许出现任何具体引擎名', () => {
  // ⭐ 范围只有 core/ 和 editor/ —— ⛔ 不含 test/。
  //    理由（2026-10-05 实测）：test/ 里拿真名片当 fixture 是**有意**的，
  //    validate/verify 的测试就是要证明「对真名片读得进去」，
  //    换成假名片那条测试就没意义了。
  //    ⛔ 但 test/ 里**不许在注释里**写具体引擎名当依赖说明。
  const dirs = [
    path.join(__dirname, '..', 'core'),
    path.join(__dirname, '..', 'editor'),
  ]
  const bad = []
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!['.js', '.jsx', '.css'].includes(path.extname(f))) continue
      const full = path.join(dir, f)
      fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
        if (SELF_RE.test(line)) return
        for (const name of ENGINE_NAMES) {
          if (line.toLowerCase().includes(name)) {
            bad.push(`${path.basename(full)}:${i + 1}  "${name}"`)
          }
        }
      })
    }
  }
  assert.deepStrictEqual(bad, [],
    `\n⛔ 活代码里出现了具体引擎名（${bad.length} 处）：\n  ${bad.join('\n  ')}\n`
    + '  向导是给**任意**上游用的 —— 装谁都该能装，不是只装那一个。\n'
    + '  ⛔ 连注释都不许写：注释里的具体名字会变成隐形的依赖。')
})

test('⛔⭐ 测试的注释里不许拿具体引擎名当依赖说明', () => {
  // ⛔ fixture 数据里的引擎名是**允许**的（那是要验证真名片读得进去）；
  //    ⛔ 但 // 注释 里写「实测 X 的 uv.lock」这种是隐形依赖 ⇒ 禁。
  const bad = []
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith('.js')) continue
    const full = path.join(__dirname, f)
    if (full === __filename) continue
    fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
      const m = line.match(/^\s*(?:\/\/|\*)\s*(.+)$/)
      if (!m) return
      for (const name of ENGINE_NAMES) {
        if (m[1].toLowerCase().includes(name)) {
          bad.push(`${f}:${i + 1}  注释里的 "${name}"`)
        }
      }
    })
  }
  assert.deepStrictEqual(bad, [],
    `\n⛔ 测试注释里出现了具体引擎名（${bad.length} 处）：\n  ${bad.join('\n  ')}\n`
    + '  fixture 数据里可以有（那是故意的），⛔ 注释里不行 —— '
    + '注释是在解释「为什么这样写」，提到具体引擎就变成隐形依赖。')
})


// ---------------------------------------------------------------------------
// ⭐ P0-补：幽灵类自动检测
//
// ⚠ 为什么要这条（2026-10-05 实测）：
//   前任在 JSX 里用了 59 个自己发明的 className，**全项目 CSS 里一个都没有**
//   ⇒ 文本裸奔、.ed-cols 塌成 block（Manifest 右栏被推到 y=3012）。
//   ⛔ 当时 186 条测试全绿 —— 因为没有一条测试查「这个类到底存不存在」。
// ✅ 这条守卫把「用了但没定义」变成红灯，⛔ 不再靠肉眼。
//   模板字面量里的 ${...} 跳过（那是运行时拼的，静态扫不准）。
// ---------------------------------------------------------------------------
test('⛔⭐ JSX 用到的每个类都必须有定义（幽灵类守卫）', () => {
  const projCls = new Set()
  for (const m of proj.matchAll(/\.([a-z][a-z0-9_-]*)/g)) projCls.add(m[1])
  for (const m of wiz.matchAll(/\.([a-z][a-z0-9_-]*)/g)) projCls.add(m[1])

  const ghosts = []
  for (const f of fs.readdirSync(WIZ)) {
    if (path.extname(f) !== '.jsx') continue
    const lines = fs.readFileSync(path.join(WIZ, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      // className="a b"  /  className={`a b`} 两种都扫；⛔ 跳过含 ${} 的（拼出来的）
      for (const m of line.matchAll(/className=\{?["`]([^"`$]*)["`]/g)) {
        for (const c of m[1].split(/\s+/)) {
          if (!c || !/^[a-z][a-z0-9_-]*$/.test(c)) continue
          if (!projCls.has(c)) ghosts.push(`${f}:${i + 1}  .${c}`)
        }
      }
    })
  }
  assert.deepStrictEqual([...new Set(ghosts)], [],
    `\n⛔ 幽灵类（用了但全项目没有定义 ⇒ 文本裸奔 / 布局塌陷）：\n  `
    + `${[...new Set(ghosts)].join('\n  ')}\n`
    + '  ⛔ 不许自己造类名。要么用 web/src/styles.css 里现成的，'
    + '要么在 editor.css 里明确定义。')
})

// ---------------------------------------------------------------------------
// ⭐⭐ P0：界面文案的**口吻**守卫（2026-10-05）
//
// ⚠ 这份守卫来自一次系统复查的结论：技术实现没问题，
//   但**文案把内部焦虑直接暴露给用户和下一个维护者**。
//   ⛔ 那不是「措辞偏好」，是产品缺陷 —— 用户看到的是我们的思考过程。
//
// 📌 判据：凡是**会显示在界面上**的字符串（error/note/why/text/hint
//   以及 t() 的中文位），一律不许出现下面这些。
// ---------------------------------------------------------------------------

/**
 * 从一行里抽出「用户可见」的字符串内容。
 *
 * ⚠⚠ 2026-10-05 这个函数漏检过两轮，代价是 Owner 亲自指出问题：
 *   它只认 `t('en', '中文')` **函数调用**，
 *   ⛔ 于是对象字面量形式（{ zh: '跟这台机器对得上' }）整个漏掉，
 *   ⛔ 连着「那段代码是死代码（0 处引用）」也一起没被发现。
 *   ⇒ 现在**三种形式都收**。
 */
function visibleStrings (line) {
  const out = []
  // ① error: '…' / note: `…` / why: '…' / caveat: `…`
  const m1 = line.match(/(?:error|note|why|text|hint|caveat|label|title)\s*:\s*[`']([^`']{3,200})/)
  if (m1) out.push(m1[1])
  // ② t('en', '中文')
  const m2 = line.match(/,\s*'([^']{3,160})'\s*\)/)
  if (m2) out.push(m2[1])
  // ③ ⭐ 对象字面量：{ zh: '…' } / { mark:…, en:…, zh:… }
  const m3 = line.match(/\bzh\s*:\s*'([^']{2,160})'/)
  if (m3) out.push(m3[1])
  return out
}

const FORBIDDEN_IN_UI = [
  // ① emoji / 骂人语气
  ['\u26d4', 'emoji ⛔（那是内部标记，不是界面文案）'],
  // ② 把内部设计原则讲给用户听
  ['平台不替你猜', '内部设计原则'],
  ['平台不会替你猜', '内部设计原则'],
  ['平台不会替你选', '内部设计原则'],
  ['这不是错', '拿我们的契约安慰用户'],
  ['契约里明确允许', '拿我们的契约安慰用户'],
  // ③ 破折号解释腔 —— 项目前端几乎不用
  ['——', '破折号解释腔'],
  // ④ 口语 —— 「对得上」「看不出来」是**人在对话里说的话**，不是界面文案
  ['对得上', '说话口气，不是软件文案'],
  ['看不出来', '说话口气，不是软件文案'],
  ['没什么', '口语'],
  ['搞定', '口语'],
  ['拿掉', '口语'],
  ['弄坏', '口语'],
  // ⑤ 内部文件路径（用户不需要知道代码在哪）
  ['installPlan.js', '内部文件名'],
  ['registry.js:', '内部文件:行号'],
  ['ROOT_LAYOUT.md', '内部文件名'],
  ['docs/', '内部路径'],
]

test('⛔⭐ 界面文案不许出现内部术语、emoji、破折号（Owner 2026-10-05 强调的口吻）', () => {
  const bad = []
  const dirs = [
    path.join(__dirname, '..', 'core'),
    path.join(__dirname, '..', 'editor'),
  ]
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!['.js', '.jsx'].includes(path.extname(f))) continue
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        // ⛔ 跳过注释：⛔ 是我们的**内部**标记，注释里可以用
        if (/^\s*(\/\/|\*)/.test(line)) return
        for (const str of visibleStrings(line)) {
          for (const [pat, why] of FORBIDDEN_IN_UI) {
            if (new RegExp(pat).test(str)) {
              bad.push(`${f}:${i + 1}  [${why}]  ${str.slice(0, 60)}`)
            }
          }
        }
      })
    }
  }
  assert.deepStrictEqual(bad, [],
    `\n⛔ 界面文案里出现了不该出现的东西（${bad.length} 处）：\n  ${bad.join('\n  ')}\n`
    + '  ⛔ 界面只说「发生了什么」和「你该怎么做」，'
    + '⛔ 不解释我们为什么这么设计。')
})

test('⛔ 注释里不许出现用户原话（脏话/情绪化措辞不能进仓库）', () => {
  // ⚠ 2026-10-05 实测：曾把 Owner 的原话（含脏话）直接抄进注释。
  //   ⛔ 那进 git 就是事故，CI 扫到要当 P0 处理。
  const BANNED = ['妈逼', '你妈', '吊儿郎当', '亮瞎', '作死', '扯淡', '妈的']
  const bad = []
  for (const dir of [path.join(__dirname, '..', 'core'),
    path.join(__dirname, '..', 'editor')]) {
    for (const f of fs.readdirSync(dir)) {
      if (!['.js', '.jsx', '.css'].includes(path.extname(f))) continue
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n')
      lines.forEach((line, i) => {
        for (const w of BANNED) {
          if (line.includes(w)) bad.push(`${f}:${i + 1}  「${w}」`)
        }
      })
    }
  }
  assert.deepStrictEqual(bad, [],
    `\n⛔ 注释里出现了不该进仓库的措辞（${bad.length} 处）：\n  ${bad.join('\n  ')}\n`
    + '  ⛔ 引用 Owner 的原话要**转述**成技术事实，不要照抄。')
})

// ---------------------------------------------------------------------------
// ⭐⭐ P0：JSX 语法守卫 —— **改文案也要能编译**
//
// ⚠⚠ 2026-10-05 实测事故：为了改一句文案，把 t('…') 的字符串
//   拆成多行时漏了右引号 ⇒ `Unterminated string constant`，
//   ⛔ 整个向导白屏。
//   ⛔ 而 `node --test` **照样 200+ 全绿** —— 因为测试根本不编译 JSX。
//   ⇒ 结论：**测试全绿 ≠ 前端能跑**。JSX 必须单独过一遍 babel。
//
// ✅ 这里做两件事：
//   ① 静态查「单引号不成对」的行（能抓到大部分）
//   ② ⭐ 真编译一遍（用 @babel/parser，项目 Vite 用的同一个）
// ---------------------------------------------------------------------------

test('⛔⭐ JSX 里的字符串引号必须成对（改文案最容易破的地方）', () => {
  const bad = []
  const WIZ = path.join(__dirname, '..', 'editor')
  for (const f of fs.readdirSync(WIZ)) {
    if (!['.jsx', '.js'].includes(path.extname(f))) continue
    const lines = fs.readFileSync(path.join(WIZ, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      // ⭐ 先消掉**双引号**字符串 —— 它们里面合法地含单引号
      //   （实测踩到：t("The request body uses this engine's own dialect:")
      //    被误报成「引号不成对」）
      let code = line.replace(/\/\/.*$/, '')
      code = code.replace(/"(?:[^"\\]|\\.)*"/g, '""')
      // 再消掉已配对的单引号字符串，剩下的单引号必须成偶数
      code = code.replace(/'(?:[^'\\]|\\.)*'/g, "''")
      if ((code.match(/'/g) || []).length % 2 !== 0) {
        bad.push(`${f}:${i + 1}  单引号不成对  ${line.trim().slice(0, 60)}`)
      }
    })
  }
  assert.deepStrictEqual(bad, [],
    `\n⛔ 有 ${bad.length} 行的字符串引号不成对（会编译失败 ⇒ 页面白屏）：\n  ${bad.join('\n  ')}`)
})

test('⛔⭐ 每个 JSX 都必须真能编译（⛔ 测试全绿 ≠ 前端能跑）', () => {
  // ⚠ 用项目 Vite 依赖的同一个 babel —— ⛔ 不用别的解析器，
  //   否则「我这能过」而 Vite 报错，等于没测（2026-10-05 实测过这个坑）。
  let parse
  try {
    parse = require(require.resolve('@babel/parser', {
      paths: [path.join(__dirname, '..', '..', '..', 'web')],
    })).parse
  } catch (e) {
    // ⚠ 拿不到 babel 就**跳过**而不是假装通过 —— ⛔ 绝不能给假绿灯
    return
  }
  const WIZ = path.join(__dirname, '..', 'editor')
  const bad = []
  for (const f of fs.readdirSync(WIZ)) {
    if (!['.jsx', '.js'].includes(path.extname(f))) continue
    const src = fs.readFileSync(path.join(WIZ, f), 'utf8')
    try {
      parse(src, {
        sourceType: 'module',
        plugins: ['jsx'],
        errorRecovery: false,
      })
    } catch (e) {
      bad.push(`${f}  ${String(e.message).split('\n')[0].slice(0, 90)}`)
    }
  }
  assert.deepStrictEqual(bad, [],
    `\n有 ${bad.length} 个文件编译失败（页面会白屏）：\n  ${bad.join('\n  ')}`)
})

test('注释与字符串里不许出现 emoji 或符号语气', () => {
  const WIZ = path.join(__dirname, '..', 'editor')
  const CORE = path.join(__dirname, '..', 'core')
  const bad = []
  for (const dir of [WIZ, CORE]) {
    for (const f of fs.readdirSync(dir)) {
      if (!['.jsx', '.js'].includes(path.extname(f))) continue
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        // 匹配 emoji 区段和常见符号语气字符
        const m = line.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u)
        if (m) bad.push(`${dir === WIZ ? 'editor' : 'core'}/${f}:${i + 1}  ${m[0]}  ${line.trim().slice(0, 60)}`)
      })
    }
  }
  assert.deepStrictEqual(bad, [],
    `\n有 ${bad.length} 处 emoji 或符号语气字符，契约 5cdf33d 全禁：\n  ${bad.join('\n  ')}`)
})
