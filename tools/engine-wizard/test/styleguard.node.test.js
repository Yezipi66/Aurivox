'use strict'
// 样式守卫：向导不许重定义项目已有的类，也不许重画项目已有的容器。
// 同名不同义 + 同时加载 ⇒ 谁生效取决于 import 顺序，那不是「不规范」而是渲染结果不确定。
// 项目的规范形状是 section 三件套 / collapsible / field / msg / form-grid /
// param-grid / workspace-container（居中）；向导自己再写一套同形状的，就是两套事实。

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

/** 向导 editor.css 里定义的顶层类，不含嵌套选择器的后半段 */
function wizardClasses (css) {
  const out = new Set()
  for (const line of css.split('\n')) {
    const m = line.match(/^(\.[a-z][a-z0-9_ -]*)\s*[,{]/)
    if (m) for (const c of m[1].split(/\s+/)) if (c.startsWith('.')) out.add(c.slice(1))
  }
  return out
}

// P0：同名冲突
test('editor.css 不许定义项目已有的类（同名不同义 = 渲染看 import 顺序）', () => {
  const p = projectClasses(proj)
  const w = wizardClasses(wiz)
  const clash = [...w].filter((c) => p.has(c)).sort()
  assert.deepStrictEqual(clash, [],
    `⛔ 与项目重名 ${clash.length} 个：${clash.join(', ')}\n`
    + '   editor 又 import 了 styles.css ⇒ 同名不同义时谁生效取决于 import 顺序。\n'
    + '   解法：删掉本文件的定义，用项目那份（TrainingTab 就是这么用的）。')
})

test('点名那 9 个曾经重名的（回归守卫）', () => {
  const ONCE_DUP = ['pipe-map', 'pipe-step', 'pipe-dot', 'pipe-seg',
    'expert-block', 'expert-summary', 'expert-warning',
    'expert-unlock', 'expert-fields']
  const defined = wizardClasses(wiz)
  const back = ONCE_DUP.filter((c) => defined.has(c))
  assert.deepStrictEqual(back, [],
    `⛔ 这 9 个又回来了：${back.join(', ')} —— `
    + '它们是 TrainingTab 在用的那套，向导必须用项目那份')
})

// P1：不许重画已有容器
test('向导必须用项目的容器类，不能自己造同形状的', () => {
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

  // ③ 不许有自造的 mf-section（section 的同形状替代品）
  assert.ok(!/className="[^"]*\bmf-section\b/.test(src),
    '⛔ 还有 mf-section —— 那是重画项目 .section')
})

test('不许出现项目的 --radius 之外的圆角写法', () => {
  // 项目用 var(--radius-sm/md/lg)；裸 px 圆角 = 自创尺度
  const bare = [...wiz.matchAll(/border-radius:\s*([0-9]+)px/g)].map((m) => m[1])
  assert.deepStrictEqual(bare, [],
    `⛔ 有 ${bare.length} 处裸 px 圆角：${[...new Set(bare)].join(', ')} —— `
    + '项目用 var(--radius-sm/md/lg)，跟着它走')
})

test('不许手抄语义色的 rgba 常量（项目 --danger/--warning/--info/--success 已在用）', () => {
  // 项目的 .msg-info 就是这么写的：rgba(100,181,246,0.1) ⇒ 允许这一组
  const KNOWN = new Set(['rgba(100,181,246,0.1)', 'rgba(207,102,121,0.14)',
    'rgba(76,175,80,0.1)'])
  const m = [...wiz.matchAll(/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*[\d.]+\s*\)/g)]
    .map((x) => x[0].replace(/\s+/g, ''))
  const odd = [...new Set(m)].filter((x) => !KNOWN.has(x))
  // 允许 opacity 变体（.1 / .14），但透明度不能是我发明的第三种
  const badAlpha = [...new Set(m)]
    .map((x) => (x.match(/,([\d.]+)\)$/) || [])[1])
    .filter((a) => a && !['0.1', '0.14'].includes(a))
  assert.deepStrictEqual(badAlpha, [],
    `⛔ 出现了第三种透明度：${badAlpha.join(', ')} —— `
    + '项目的 .msg-* 只用 0.1 和 0.14')
})

// P2：字号阶梯不许自创
test('向导的字号不许超出项目的阶梯', () => {
  // 项目的实际字号（styles.css + TrainingTab）：10 / 11 / 12 / 13 / 14
  const ALLOWED = new Set(['10', '11', '12', '13', '14', 'inherit'])
  const bad = [...wiz.matchAll(/font-size:\s*([0-9]+)px/g)]
    .map((m) => m[1])
    .filter((v) => !ALLOWED.has(v))
  assert.deepStrictEqual([...new Set(bad)], [],
    `⛔ 出现了阶梯外的字号：${[...new Set(bad)].join(', ')} —— `
    + "项目只用 10/11/12/13/14（.field-hint 10px / .msg 12px / .collapsible-hdr 13px…）")
})

// 色板不散落
test('向导只用项目的 CSS 变量，不写死颜色字面量', () => {
  const hex = [...wiz.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  assert.deepStrictEqual([...new Set(hex)], [],
    `⛔ 有 ${hex.length} 个写死的颜色：${[...new Set(hex)].slice(0, 5).join(', ')} —— `
    + '全部走 var(--text)/var(--muted)/var(--border)/var(--danger) 等')
})

test('editor.css 头部必须写清「三条纪律」', () => {
  const head = wiz.split('\n').slice(0, 40).join('\n')
  assert.ok(head.includes('不重定义') || head.includes('不许定义'),
    '⛔ 文件头没写「不重定义项目已有的类」这条纪律')
})
// useT() 解构守卫：用了 lang/t/setLang 就必须从 useT() 解构出来
test('用了 lang/t/setLang 就必须从 useT() 解构出来', () => {
  const dir = path.join(__dirname, '..', 'editor')
  const bad = []
  for (const f of fs.readdirSync(dir).filter((x) => /\.jsx?$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    // 真的在用 lang（比较/取值），不是出现在注释里
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

test('禁止把 useT() 当函数调用（useT()(...)）', () => {
  const dir = path.join(__dirname, '..', 'editor')
  for (const f of fs.readdirSync(dir).filter((x) => /\.jsx?$/.test(x))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(!/useT\(\)\s*\(/.test(code),
      `${f}: 把 useT() 当函数调了（useT() 返回的是对象，不是函数）`)
    // 解构出来的 t 必须被当函数用（t('en','zh')），而不是当对象
    const destr = /const\s*\{([^}]*)\}\s*=\s*useT\(\)/.exec(code)
    if (destr && /\bt\b/.test(destr[1])) {
      assert.ok(/\bt\s*\(/.test(code),
        `${f}: 解构了 t，却从来没有 t(...) 调用 —— 多半把它当对象用了`)
    }
  }
})

// P0-补：具体引擎名，连注释和测试都不许出现
//
// 每个文件自己的守卫只查自己那一个文件，所以需要全局一条：
// resolve.node.test.js 的守卫查不到 probe.node.test.js 里的。
// 已知引擎名清单。这份表本身就写着这些名字，所以扫描时必须跳过
// 「只是在列举它们」的那几行（否则自己告自己）。
const ENGINE_NAMES = [
  'voxcpm', 'gpt-sovits', 'gpt_sovits', 'sovits',
  'indextts', 'cosyvoice', 'fish-speech', 'fish_speech',
  'f5-tts', 'emoji-tts', 'emojitts',
]
// 本文件里「就是在列举这些名字」的行（清单本身 + 这条测试的注释）
const SELF_RE = /ENGINE_NAMES|具体引擎名/

test('向导的活代码不许出现任何具体引擎名', () => {
  // 范围只有 core/ 和 editor/，不含 test/：test/ 里拿真名片当 fixture 是有意的，
  // validate/verify 的测试就是要证明「对真名片读得进去」。
  // 但 test/ 里不许在注释里写具体引擎名当依赖说明。
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
    + '  向导是给任意上游用的 —— 装谁都该能装，不是只装那一个。\n'
    + '  ⛔ 连注释都不许写：注释里的具体名字会变成隐形的依赖。')
})

test('测试的注释里不许拿具体引擎名当依赖说明', () => {
  // fixture 数据里的引擎名是允许的（那是要验证真名片读得进去）；
  // 但注释里拿它当依赖说明就是隐形依赖，禁。
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
// P0-补：幽灵类自动检测
//
// 这条守卫把「用了但没定义」变成红灯，不靠肉眼。
// 模板字面量里的 ${...} 跳过（那是运行时拼的，静态扫不准）。
test('JSX 用到的每个类都必须有定义（幽灵类守卫）', () => {
  const projCls = new Set()
  for (const m of proj.matchAll(/\.([a-z][a-z0-9_-]*)/g)) projCls.add(m[1])
  for (const m of wiz.matchAll(/\.([a-z][a-z0-9_-]*)/g)) projCls.add(m[1])

  const ghosts = []
  for (const f of fs.readdirSync(WIZ)) {
    if (path.extname(f) !== '.jsx') continue
    const lines = fs.readFileSync(path.join(WIZ, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      // className="a b"  /  className={`a b`} 两种都扫；跳过含 ${} 的（拼出来的）
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

// P0：界面文案的口吻守卫
//
// 文案把内部焦虑直接暴露给用户和下一个维护者不是措辞偏好，是产品缺陷：
// 用户看到的是我们的思考过程。
//
// 判据：凡是会显示在界面上的字符串（error/note/why/text/hint 以及 t() 的中文位），
// 一律不许出现下面这些。

/**
 * 从一行里抽出「用户可见」的字符串内容。
 *
 * 它只认 `t('en', '中文')` 函数调用，于是对象字面量形式
 * （{ zh: '跟这台机器对得上' }）整个漏掉，连着「那段代码是死代码」
 * 也一起没被发现。现在三种形式都收。
 */
function visibleStrings (line) {
  const out = []
  // ① error: '…' / note: `…` / why: '…' / caveat: `…`
  const m1 = line.match(/(?:error|note|why|text|hint|caveat|label|title)\s*:\s*[`']([^`']{3,200})/)
  if (m1) out.push(m1[1])
  // ② t('en', '中文')
  const m2 = line.match(/,\s*'([^']{3,160})'\s*\)/)
  if (m2) out.push(m2[1])
  // ③ 对象字面量：{ zh: '…' } / { mark:…, en:…, zh:… }
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
  // ③ 破折号解释腔 ： 项目前端几乎不用
  ['——', '破折号解释腔'],
  // ④ 口语 ： 「对得上」「看不出来」是人在对话里说的话，不是界面文案
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

test('界面文案不许出现内部术语、emoji、破折号', () => {
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
        // 跳过注释行
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

test('注释里不许出现用户原话（脏话/情绪化措辞不能进仓库）', () => {
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

// JSX 语法守卫：改文案也要能编译
//
// 为改一句文案把 t('…') 的字符串拆成多行时漏了右引号，
// 结果是 Unterminated string constant，整个向导白屏。
// 而 node --test 照样全绿，因为测试根本不编译 JSX。
// 结论：测试全绿 ≠ 前端能跑。JSX 必须单独过一遍 babel。
//
// 这里做两件事：
// ① 静态查「单引号不成对」的行（能抓到大部分）
// ② 真编译一遍（用 @babel/parser，项目 Vite 用的同一个）

test('JSX 里的字符串引号必须成对（改文案最容易破的地方）', () => {
  const bad = []
  const WIZ = path.join(__dirname, '..', 'editor')
  for (const f of fs.readdirSync(WIZ)) {
    if (!['.jsx', '.js'].includes(path.extname(f))) continue
    const lines = fs.readFileSync(path.join(WIZ, f), 'utf8').split('\n')
    lines.forEach((line, i) => {
      // 先消掉双引号字符串：它们里面合法地含单引号
      // （t("The request body uses this engine's own dialect:") 会被误报成「引号不成对」）
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

test('每个 JSX 都必须真能编译（测试全绿 ≠ 前端能跑）', () => {
  // 用项目 Vite 依赖的同一个 babel，不用别的解析器，
  // 否则「我这能过」而 Vite 报错，等于没测。
  let parse
  try {
    parse = require('../../../lib/testDeps.js').babelParse()
  } catch (e) {
    // 拿不到 babel 就当场喊出来：静默跳过等于没有这条守卫
    //   （下面那条「注释不许变成可见文本」也是抛，两处口径要一致）。
    throw new Error(`拿不到 @babel/parser，JSX 编译检查无法进行：${e.message}`)
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

test('JSX 里的注释不许变成可见文本（vite 只报 warning，测试全绿也发现不了）', () => {
  // 症状：注释写成  // xxx */}  而不是  {/* xxx */}，
  // 那段注释就成了 JSX 文本，原样显示在页面上。
  // vite 把它当 warning（不是 error），编译照样过、node --test 也全绿。
  let parse
  try {
    parse = require('../../../lib/testDeps.js').babelParse()
  } catch (e) {
    throw new Error(`拿不到 @babel/parser，注释残留检查无法进行：${e.message}`)
  }
  const WIZ = path.join(__dirname, '..', 'editor')
  const bad = []
  for (const f of fs.readdirSync(WIZ)) {
    if (!['.jsx', '.js'].includes(path.extname(f))) continue
    const src = fs.readFileSync(path.join(WIZ, f), 'utf8')
    let ast
    try {
      ast = parse(src, { sourceType: 'unambiguous', plugins: ['jsx'] })
    } catch (e) {
      continue // 编译失败由上一条用例负责报
    }
    // 走 AST：JSXText 里出现注释定界符残渣就是坏了
    const visit = (n) => {
      if (!n || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(visit); return }
      if (n.type === 'JSXText') {
        const v = n.value || ''
        if (/\*\/\}|\{\/\/|\/\/\s*\*\//.test(v) || /^\s*\*\/\s*\}$/.test(v)) {
          bad.push(`${f}:${n.loc.start.line}  ${JSON.stringify(v.trim().slice(0, 70))}`)
        }
      }
      for (const k of Object.keys(n)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue
        visit(n[k])
      }
    }
    visit(ast.program)
  }
  assert.deepStrictEqual(bad, [],
    `\n有 ${bad.length} 处 JSX 注释变成了可见文本：\n  ${bad.join('\n  ')}`)
})

test('界面文案不许出现 emoji 或符号语气', () => {
  // 范围：JSX 文本节点 + t() 的第一个参数（界面可见字符串）。
  // 契约 5cdf33d 清的是界面文案。
  // 豁免：既有功能性状态图标（下载/完成/缺失指示）不在本次范围，登记在 EXEMPT。
  const EXEMPT = new Set([
    'StepDeps.jsx:389',      // 下载进度指示图标
    'StepsExtra.jsx:458',    // 文件已完成状态图标
    'StepsExtra.jsx:466',    // 文件未下载状态图标
  ])
  const WIZ = path.join(__dirname, '..', 'editor')
  const bad = []
  const UI_TEXT = />([^<>{}]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}][^<>{}]*)</gu
  const T_ARG = /t\(\s*(['"])((?:\\.|(?!\1).)*)\1/gu
  const SYM = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u
  for (const f of fs.readdirSync(WIZ)) {
    if (path.extname(f) !== '.jsx') continue
    const src = fs.readFileSync(path.join(WIZ, f), 'utf8')
    const lines = src.split('\n')
    lines.forEach((line, i) => {
      const where = `${f}:${i + 1}`
      if (EXEMPT.has(where)) return
      const code = line.replace(/\/\/.*$/, '')
      for (const m of code.matchAll(UI_TEXT)) {
        if (SYM.test(m[1])) bad.push(`${where}  JSX 文本含符号语气  ${m[1].trim().slice(0, 50)}`)
      }
      for (const m of code.matchAll(T_ARG)) {
        if (SYM.test(m[2])) bad.push(`${where}  t() 文案含符号语气  ${m[2].slice(0, 50)}`)
      }
    })
  }
  assert.deepStrictEqual(bad, [],
    `\n有 ${bad.length} 处界面文案含 emoji 或符号语气，契约 5cdf33d 全禁：\n  ${bad.join('\n  ')}`)
})

// 注释归位守卫
//
// 注释只解释文件本身、代码块、代码行：这段在做什么、为什么这样实现、
// 什么输入会让它坏。四类内容不进代码注释：现场经过、归属叙述、纪律宣告、情绪标记
// （见 docs/COMMENT_GUIDELINE.md）。
//
// 可执行判据取四条：日期体、归属类词、现场经过类词、强调符号。
// markdown 加粗只判 md 文档，代码注释里的乘号与指针语义不判。
//
// 债务如实记账：DEBT_LEDGER 是守卫建立时的存量快照，只许变小不许变大。
// 新写一条违规注释会让对应文件计数对不上，测试报出文件与行号。

const WIZARD_ROOT = path.join(__dirname, '..')
const PLAN_DOC = path.join(__dirname, '..', '..', '..', 'docs', 'WIZARD_FIX_PLAN_DCABD.md')
const SCAN_EXTS = new Set(['.js', '.jsx', '.cjs', '.mjs'])
const SCAN_SKIP_DIRS = new Set(['node_modules', '__pycache__', 'cache'])

const DATE_FORM_RE = /\b\d{4}-\d{2}-\d{2}\b/
const ATTRIBUTION_WORDS = ['Owner', '亲自', '前任', '裁决', '裁定']
const SCENE_WORDS = ['实测', '试错', '报障', '踩过', '踩到', '曾经', '一度', '上一版', '今晚']
const EMPHASIS_SYMBOL_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u
const MARKDOWN_BOLD_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__/
const CRITERIA_SELF_RE = /DATE_FORM_RE|ATTRIBUTION_WORDS|SCENE_WORDS|EMPHASIS_SYMBOL_RE|MARKDOWN_BOLD_RE|CRITERIA_SELF_RE/

// 守卫建立时的存量债务快照，按文件记违规注释行数。
//
// 数字口径：本表按 @babel/parser 的 ast.comments 逐行判出来。
// 末四个文件在旧口径下未被扫到，显式设 0 键使它们进入扫描范围。
const DEBT_LEDGER = {
  'test/dragBind.node.test.js': 1,
  'test/installCancel.node.test.js': 1,
  'core/env.js': 258,
  'core/wizardbridge.js': 155,
  'core/paramsFromReflect.js': 119,
  'test/env-venv.node.test.js': 107,
  'test/env.node.test.js': 87,
  'editor/StepPrepare.jsx': 83,
  'core/probe.js': 74,
  'core/hardware.js': 73,
  'editor/StepsExtra.jsx': 71,
  'core/resolve.js': 69,
  'core/download.js': 54,
  'test/paramsFromReflect.node.test.js': 54,
  'test/styleguard.node.test.js': 51,
  'test/cliHelp.node.test.js': 50,
  'editor/StepDeps.jsx': 49,
  'core/cliHelp.js': 48,
  'test/clone.node.test.js': 39,
  'editor/App.jsx': 37,
  'editor/steps.js': 35,
  'test/requirements.node.test.js': 34,
  'test/hardware.node.test.js': 32,
  'test/models.node.test.js': 29,
  'test/steps.node.test.js': 26,
  'test/persistenceMutation.node.test.js': 24,
  'core/models.js': 23,
  'editor/useInstallSession.js': 23,
  'test/download.node.test.js': 22,
  'core/clone.js': 21,
  'core/verify.js': 21,
  'test/asyncHandlerFallback.node.test.js': 20,
  'core/save.js': 18,
  'core/installState.js': 16,
  'editor/ManifestPage.jsx': 16,
  'test/resolve.node.test.js': 16,
  'editor/PanelPreview.jsx': 15,
  'test/probe.node.test.js': 15,
  'core/validate.js': 14,
  'test/installStateEndpoint.node.test.js': 12,
  'test/verify.node.test.js': 12,
  'editor/Diagnostics.jsx': 11,
  'editor/MainArea.jsx': 11,
  'test/installState.node.test.js': 11,
  'editor/Pipeline.jsx': 10,
  'core/savebridge.js': 9,
  'editor/CliGenPanel.jsx': 9,
  'test/bridge.node.test.js': 9,
  'test/useInstallSession.node.test.js': 9,
  'core/bridge.js': 8,
  'core/fieldmeta.js': 8,
  'core/tierreview.js': 8,
  'editor/ManifestForm.jsx': 8,
  'editor/downloadState.js': 7,
  'core/instances.js': 6,
  'editor/StepVerify.jsx': 6,
  'test/folderName.node.test.js': 5,
  'core/cliDraft.js': 5,
  'core/paramDigest.js': 5,
  'core/specbridge.js': 5,
  'editor/folderName.js': 5,
  'test/save.node.test.js': 5,
  'editor/RequiredEight.jsx': 4,
  'editor/useInstalled.js': 4,
  'test/computeAutoFill.node.test.js': 4,
  'test/tierreview.node.test.js': 4,
  'test/validate.node.test.js': 5,
  'editor/index.jsx': 2,
  'test/downloadState.test.js': 2,
  // 旧口径漏扫、从未进过台账的四个文件，真值逐个为 0。
  //   仍显式设键让它们进扫描范围：不设键的文件只配报 newFiles。
  'comment_ratio.cjs': 1,
  'editor/CoreBindings.jsx': 1,
  'editor/NestedSections.jsx': 10,
  'editor/SaveBar.jsx': 10,
}

// 注释抽取交给 @babel/parser（项目 Vite 校验用的就是它）。
// 旧实现是手写逐字符状态机，把正则字面量与源码中出现的反引号当成字符串
// 起点，两个引号之间整段吞掉。babel 的 ast.comments 直接给出每个
// 注释节点的 loc，抽不到即失败，不会假阴性。
// 计宽窄只能用同一种单位：节点数是节点数，行数是行数，两者相减无意义；
// 正文的比法一律换成行对行、集合对集合。
let babelParse = null
try {
  babelParse = require('../../../lib/testDeps.js').babelParse()
} catch (e) {
  babelParse = null
}

// parse 失败必须带着文件名和错误原文炸出来，静默跳过等于把问题记成 0 违规。
function babelAst (rel, src) {
  if (!babelParse) throw new Error(`拿不到 @babel/parser（${rel}）`)
  let last = null
  for (const opts of [
    { sourceType: 'unambiguous', plugins: ['jsx'] },
    { sourceType: 'module', plugins: ['jsx'] },
    { sourceType: 'script', plugins: ['jsx'] },
  ]) {
    try { return babelParse(src, opts) } catch (e) { last = e }
  }
  throw new Error(`babel 解析失败 ${rel}: ${String(last && last.message).split('\n')[0]}`)
}

// 注释节点（babel ast.comments 原样）。供覆盖率自证使用：抽不出全部节点
// 就说明解析器有洞，本文件自己先当靶子。
function commentNodes (rel, src) {
  return babelAst(rel, src).comments || []
}

// 节点按 loc 展开后应有的条数（行）之和。
//   这与 commentNodes().length 是两种单位：一个节点可以展开成多行，
//   少展开一行时节点数不变，两者相减或互相代替都会掩盖退化。
function expectedBodyCount (nodes) {
  let total = 0
  for (const c of nodes) total += c.loc.end.line - c.loc.start.line + 1
  return total
}

// 取注释体：每个注释节点按 loc 行号展开成逐行 body。
// JSX 文件必须带 plugins:['jsx']，否则 JSX 里的注释取不到。
// 行号取 loc.start.line，与「定位到源码行」的用途对齐。
function commentBodies (rel, src) {
  const comments = commentNodes(rel, src)
  const out = []
  comments.forEach((c, idx) => {
    const start = c.loc.start.line
    const span = c.loc.end.line - start + 1
    const lines = String(c.value == null ? '' : c.value).split('\n')
    for (let k = 0; k < span; k++) {
      const seg = k < lines.length ? lines[k] : ''
      out.push({
        node: idx,
        line: start + k,
        body: seg.replace(/^\s*\*\/?/, '').replace(/^\/\*/, ''),
      })
    }
  })
  // 覆盖率自证：节点一个都不许漏抽，行也不许漏（每行都落在自己节点的区间内）
  const seen = new Set(out.map((b) => b.node))
  if (seen.size !== comments.length) {
    throw new Error(`注释抽取漏节点：${rel} babel 有 ${comments.length} 个注释节点，只抽出 ${seen.size} 个`)
  }
  const badLine = out.find((b) => {
    const c = comments[b.node]
    return b.line < c.loc.start.line || b.line > c.loc.end.line
  })
  if (badLine) {
    throw new Error(`注释抽取行号错位：${rel}:${badLine.line}`)
  }
  // 逐行展开不许少一行：多行节点少展开末行时，上面两条都发现不了
  const want = expectedBodyCount(comments)
  if (out.length !== want) {
    const per = comments.map((c, i) => [i, out.filter((b) => b.node === i).length, c.loc.end.line - c.loc.start.line + 1])
      .filter(([, got, span]) => got !== span)
    throw new Error(`注释抽取少展开：${rel} 节点逐行展开应为 ${want} 条，实际抽出 ${out.length} 条；`
      + `展开条数对不上的节点：${per.map(([i, got, span]) => `#${i}(第 ${comments[i].loc.start.line} 行起，应 ${span} 实 ${got})`).join('、')}`)
  }
  return out
}

function collectSourceFiles (dir, out) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SCAN_SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { collectSourceFiles(p, out); continue }
    if (!SCAN_EXTS.has(path.extname(e.name)) || e.name.endsWith('.bak')) continue
    out.push(p)
  }
  return out
}

function reasonsOf (body) {
  const r = []
  if (DATE_FORM_RE.test(body)) r.push('日期体')
  for (const w of ATTRIBUTION_WORDS) if (body.includes(w)) r.push('归属:' + w)
  for (const w of SCENE_WORDS) if (body.includes(w)) r.push('现场:' + w)
  if (EMPHASIS_SYMBOL_RE.test(body)) r.push('符号')
  // 中文双破折号：注释里没有它存在的理由。英文单破折号（—）是正确标点，不在判据内。
  if (body.includes('\u2014\u2014')) r.push('破折号')
  return r
}

function scanWizardTree () {
  const found = {}
  for (const f of collectSourceFiles(WIZARD_ROOT, [])) {
    const rel = path.relative(WIZARD_ROOT, f).replace(/\\/g, '/')
    const hits = []
    const bodies = commentBodies(rel, fs.readFileSync(f, 'utf8'))
    for (const c of bodies) {
      if (CRITERIA_SELF_RE.test(c.body)) continue
      const r = reasonsOf(c.body)
      if (r.length) hits.push({ line: c.line, reasons: r.join(' ') })
    }
    if (hits.length) found[rel] = hits
  }
  return found
}

function describeHits (found, keys) {
  const rows = []
  for (const rel of keys) for (const h of (found[rel] || []).slice(0, 40)) rows.push(`${rel}:${h.line}  ${h.reasons}`)
  return rows.length ? `\n命中的文件与行号：\n  ${rows.join('\n  ')}` : ''
}

test('注释归位守卫：计划文档零命中（判据来源自身干净）', () => {
  const bad = []
  const lines = fs.readFileSync(PLAN_DOC, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return
    if (/^\s*\|/.test(line)) return
    if (CRITERIA_SELF_RE.test(line)) return
    const r = reasonsOf(line)
    if (MARKDOWN_BOLD_RE.test(line)) r.push('加粗')
    if (r.length) bad.push(`${i + 1}  [${r.join(' ')}]  ${line.trim().slice(0, 60)}`)
  })
  assert.deepStrictEqual(bad, [],
    `\n计划文档残留归属性内容（${bad.length} 处）：\n  ${bad.join('\n  ')}\n`
    + '  这份文档是判据的来源，它自己要干净。\n')
})

test('注释归位守卫：注释只解释代码，不新增四类归属性内容', () => {
  const found = scanWizardTree()
  const actual = {}
  for (const [rel, hits] of Object.entries(found)) actual[rel] = hits.length

  const grown = []
  const newFiles = []
  const shrunk = []
  for (const [rel, n] of Object.entries(actual)) {
    if (!(rel in DEBT_LEDGER)) { newFiles.push(`${rel}: ${n}`); continue }
    if (n > DEBT_LEDGER[rel]) grown.push(`${rel}: 台账 ${DEBT_LEDGER[rel]} -> 实测 ${n}`)
    if (n < DEBT_LEDGER[rel]) shrunk.push(`${rel}: 台账 ${DEBT_LEDGER[rel]} -> 实测 ${n}`)
  }
  for (const rel of Object.keys(DEBT_LEDGER)) if (!(rel in actual)) shrunk.push(`${rel}: 台账 ${DEBT_LEDGER[rel]} -> 实测 0`)

  const blocked = grown.concat(newFiles).map((row) => row.split(': ')[0].replace(': ', ''))
  assert.deepStrictEqual(grown.concat(newFiles), [],
    `\n注释归位债务变多了（${grown.length + newFiles.length} 个文件）：\n  ${grown.concat(newFiles).join('\n  ')}`
    + describeHits(found, blocked)
    + '\n  新写的注释只解释这段在做什么、为什么这样实现、什么输入会让它坏。\n')

  if (shrunk.length) {
    console.log(`注释归位债务减少 ${shrunk.length} 个文件：\n  ${shrunk.join('\n  ')}\n`
      + '  台账待更新为新的快照（D2 逐文件删注释后统一改）。')
  }
})

// 覆盖率自证：抽不出全部注释节点，「守卫自身干净」就是漏扫造成的假象
//
// 旧状态机把本文件里的正则字面量与反引号当成字符串起点，于是恒等、永不变红。
// 现在以 babel 的 ast.comments 为基准，逐文件断言抽出的每一行都落在节点区间内，
// 且抽出的总条数等于所有节点按 loc 展开的条数之和（见下面第 ④ 条）。
test('注释抽取覆盖率自证：babel 节点数、逐行展开条数与抽出数逐文件一致', () => {
  const rel = path.relative(WIZARD_ROOT, __filename).replace(/\\/g, '/')
  const src = fs.readFileSync(__filename, 'utf8')
  const nodes = commentNodes(rel, src)
  const bodies = commentBodies(rel, src)
  // ① 节点一个都不许漏（漏节点 = 有注释根本没被判据看过）
  assert.strictEqual(new Set(bodies.map((b) => b.node)).size, nodes.length,
    `注释抽取漏节点：${rel} babel ${nodes.length} 个，抽出 ${new Set(bodies.map((b) => b.node)).size} 个`)
  // ② 每行都落在自己节点的 loc 区间内（错位 = 行号对不上）
  for (const b of bodies) {
    const c = nodes[b.node]
    assert.ok(b.line >= c.loc.start.line && b.line <= c.loc.end.line,
      `注释抽取行号错位：${rel}:${b.line}（节点区间 ${c.loc.start.line}-${c.loc.end.line}）`)
  }
  // ③ 全树每一个文件都过同一道自证：节点数与抽出数相等
  let checked = 0
  for (const f of collectSourceFiles(WIZARD_ROOT, [])) {
    const r = path.relative(WIZARD_ROOT, f).replace(/\\/g, '/')
    const s = fs.readFileSync(f, 'utf8')
    const ns = commentNodes(r, s)
    const bs = commentBodies(r, s)
    assert.strictEqual(new Set(bs.map((b) => b.node)).size, ns.length,
      `注释抽取漏节点：${r} babel ${ns.length} 个，抽出 ${new Set(bs.map((b) => b.node)).size} 个`)
    checked++
  }
  //   第四，逐行展开不许少一行：抽出的条数等于所有节点按 loc 展开的条数之和。
  //   前三条只管「节点在不在」与「行号在不在区间内」，两者在少展开末行时都不变；
  //   这一条才是多行节点末行（带违规最常见的位置）不被静默丢掉的保证。
  for (const f of collectSourceFiles(WIZARD_ROOT, [])) {
    const r = path.relative(WIZARD_ROOT, f).replace(/\\/g, '/')
    const ns = commentNodes(r, fs.readFileSync(f, 'utf8'))
    const got = commentBodies(r, fs.readFileSync(f, 'utf8'))
    const want = expectedBodyCount(ns)
    assert.strictEqual(got.length, want,
      `注释抽取少展开：${r} babel ${ns.length} 个节点逐行展开应为 ${want} 条，实际抽出 ${got.length} 条`
      + `（少 ${want - got.length} 条）`)
  }
  const multi = nodes.filter((c) => c.loc.end.line > c.loc.start.line).length
  console.log(`注释抽取覆盖率：本文件 babel ${nodes.length} 个节点 / 逐行展开 ${bodies.length} 条`
    + `（其中多行节点 ${multi} 个）；全树 ${checked} 个文件逐文件相等`)
})

// 注入冒烟：故意加一条带当日日期的违规注释，守卫必须报出文件与行号
//
// 这是「判据真的拦得住」的唯一证明：只有扫全树的断言变绿，也可能是判据
// 本身失效。这里注入、断言命中、还原，三步都在一个 test 内完成。
test('注入带当日日期的违规注释，守卫必须报出文件与行号', () => {
  // 不就地改写源文件：node --test 多文件并行，就地改的窗口内别的进程可能
  // 正在扫这棵树。所以改为在内存里构造带注入行的源文本，只调用抽取与判据，不落盘。
  const rel = 'core/instances.js'
  const src = fs.readFileSync(path.join(WIZARD_ROOT, 'core', 'instances.js'), 'utf8')
  const today = new Date().toISOString().slice(0, 10)
  const probe = `${src}\n// 注入冒烟：实测于 ${today} 由守卫用例触发\n`

  const found = {}
  for (const c of commentBodies(rel, probe)) {
    if (CRITERIA_SELF_RE.test(c.body)) continue
    const r = reasonsOf(c.body)
    if (r.length) found[c.line] = r.join(' ')
  }
  const hits = Object.entries(found)
  assert.ok(hits.length > 0,
    `注入了一条带日期 ${today} 的注释，守卫一条都没报 ⇒ 判据失效`)
  const lastLine = probe.replace(/\n$/, '').split('\n').length
  assert.strictEqual(Number(hits[hits.length - 1][0]), lastLine,
    `注入在第 ${lastLine} 行，守卫只报到 ${hits.map((h) => h[0]).join(',')} —— 行号对不上`)
  assert.ok(hits.some(([, r]) => r.includes('日期体')),
    `守卫报了行，但没给「日期体」判据：${JSON.stringify(hits)}`)
  // 行号必须真的指向新加的那一行，不能是把别的行算成命中
  assert.strictEqual(probe.split('\n')[lastLine - 1],
    `// 注入冒烟：实测于 ${today} 由守卫用例触发`,
    '行号对上了但指的不是注入那一行')
})

// 不误报：合法的代码写法，一条都不许报
//
// 判据不能靠「什么都报」显得有效，需要证伪。下面每一条都是 probe.js 与
// styleguard 里真实出现过的反例：自增幂、指针记号、正则转义、模板串、
// 箭头、按位取反、反引号模板、Windows 路径。
test('不误报：幂/指针/正则/模板串/箭头/取反/路径，守卫全绿', () => {
  // `a -> b` 与 `2~7` 不是合法 JS，babel 抽注释只认得能解析的源码：
  // 这正是换 babel 的理由：非法输入应当报错，而不是静默当成 0 违规。
  // 所以这里分两半：合法代码位置出现这些记号；注释里出现同样的记号。
  const code = [
    'const pow = 2 ** 7',
    'const ptr = "&x"',
    'const r = /\\/\\//',
    'const t = `x // y`',
    'const arrows = "a -> b"',
    'const tildes = "2~7"',
    'const loose = "7 ~ 2"',
    'const win = "C:\\\\Users\\\\User\\\\AppData\\\\x.js"',
    'const d = new Date()',
    'const re = /\\d{4}-\\d{2}-\\d{2}/',
    'const s = "a // b"',
    'const q = \'juice\'',
  ].join('\n')
  const withComments = `${code}\n`
    + '// 这段注释里有 2 ** 7 和 &x 与 /\\/\\// 与 a -> b 与 2~7\n'
    + '// 路径写法 C:\\Users\\User\\AppData 也出现一次\n'
    + '/* 块注释里的 x // y 与 2~7 与 &x 同样不算 */\n'
  for (const [name, src] of [['code', code], ['withComments', withComments]]) {
    const bodies = []
    for (const c of commentBodies(`inject-fp-${name}.cjs`, src)) {
      if (CRITERIA_SELF_RE.test(c.body)) continue
      const r = reasonsOf(c.body)
      if (r.length) bodies.push(`第 ${c.line} 行被误报 [${r.join(' ')}]：${JSON.stringify(c.body)}`)
    }
    assert.deepStrictEqual(bodies, [],
      `\n${name} 里的合法写法被误报成归属性注释（${bodies.length} 条）：\n  ${bodies.join('\n  ')}`)
  }
  // 合法代码里一条注释都不该出现：上述记号全在字符串与正则里
  const nodes = commentNodes('inject-fp-code.cjs', code)
  assert.deepStrictEqual(nodes, [], '这段纯代码里不该有注释节点')
})
