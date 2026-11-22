'use strict'
// 第 4 步的页面骨架：左边条、中栏、右边条，三根平级的骨头。
//
// 这条守卫来自两次真实的事故：
//   第一次：三栏容器 .wz-three-zone 被放进了项目的 .workspace-grid 里，
//   而那个 grid 自己就是两列（minmax(0,1fr) 380px）
//   ⇒ 三栏容器被塞进它的第一列，中栏从 690px 缩成 302px。
//   第二次：整页套在平台的 .node-detail 里（紫色描边 + 圆角 + 底色），
//   页面骨架被当成了卡片内容：边框套边框、圆角套圆角，
//   三根骨头挤在一个 1400px 的盒子里，中栏被活活挤死。
//
// 为什么别的守卫抓不到：
//   - 逐文件编译：语法没问题，照样绿。
//   - Vite 构建：能构建出来，照样绿。
//   - jsdom 渲染：jsdom 不做布局计算，所有元素宽度都是 0，照样绿。
//   只有真浏览器里量出来的宽度才会说话。
//
// 所以这里用 CSS 规则本身做判据：读 editor.css 与 styles.css，
// 断言骨架层没有多出来的容器、边条宽度对、中栏有弹性。
// 判据落在「声明」上而不是「渲染结果」上 ⇒ 不需要浏览器也能跑。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const EDITOR_CSS = path.join(EDITOR, 'editor.css')
const PAGE = path.join(EDITOR, 'ManifestPage.jsx')
const APP = path.join(EDITOR, 'App.jsx')
const STAGE = path.join(EDITOR, 'Stage.jsx')

const css = fs.readFileSync(EDITOR_CSS, 'utf8')
const page = fs.readFileSync(PAGE, 'utf8')
const app = fs.readFileSync(APP, 'utf8')
const stage = fs.readFileSync(STAGE, 'utf8')

/** 从 CSS 里取出某个选择器的声明块。 */
function ruleBody (selector) {
  const re = new RegExp(
    `(^|[}\\n])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')
  const m = css.match(re)
  return m ? m[2] : null
}

test('名片页的外层容器不是项目的两列 grid', () => {
  // .workspace-grid 本身就是两列：minmax(0, 1fr) 380px。
  // 三栏容器放进去会被塞进第一列。
  assert.ok(!/className="workspace-grid"/.test(page),
    '名片页又用回了 .workspace-grid：三栏容器会被塞进它的第一列，'
    + '中栏会缩成第一列宽度里的一小块')

  assert.ok(/className="wz-manifest-layout"/.test(page),
    '名片页的外层容器应当是 .wz-manifest-layout')
})

test('.wz-manifest-layout 是单列 flex，不是 grid', () => {
  const body = ruleBody('.wz-manifest-layout')
  assert.ok(body, 'editor.css 里没有 .wz-manifest-layout')
  assert.ok(/display:\s*flex/.test(body), '.wz-manifest-layout 必须是 flex')
  assert.ok(!/display:\s*grid/.test(body),
    '.wz-manifest-layout 要是 grid，就会重新引入外层列 ⇒ 三栏又被挤')
  assert.ok(/flex-direction:\s*column/.test(body),
    '.wz-manifest-layout 必须是竖排：三栏一行，各栏自己带头')
})

test('骨架层是 flex 行：两根边条 + 中栏，三者平级', () => {
  const body = ruleBody('.wz-stage')
  assert.ok(body, 'editor.css 里没有 .wz-stage')
  assert.ok(/display:\s*flex/.test(body), '.wz-stage 必须是 flex 行')
  assert.ok(!/display:\s*grid/.test(body),
    '.wz-stage 要是 grid，就又变成三列并排的板子了')
})

test('边条零宽不占中栏；抽屉是固定宽度滑出，不靠改宽度', () => {
  const body = ruleBody('.wz-drawer')
  assert.ok(body, 'editor.css 里没有 .wz-drawer')
  // 边条不占中栏宽度：中栏永远独占整行，边条只是贴边缘的 sticky 定位锚点。
  assert.ok(/flex:\s*0 0 0/.test(body),
    '边条在 flex 行里零宽，不从中栏宽度里占 32px')
  assert.ok(/width:\s*0/.test(body),
    '边条宽度 0，可见的把手与面板都绝对定位贴在视口边缘')

  const panel = ruleBody('.wz-drawer-panel')
  assert.ok(panel, 'editor.css 里没有 .wz-drawer-panel')
  assert.ok(/width:\s*var\(--wz-drawer-w,\s*392px\)/.test(panel),
    '面板宽度恒定在 392px（生成页右栅 380 + 抽屉左右内边距 24），收起时也不变')
  assert.ok(/transition:\s*transform/.test(panel),
    '展开动画只能动 transform：宽度过渡会每帧重新布局，里面整棵树跟着重排')
  assert.doesNotMatch(panel, /transition:[^;]*width/,
    '宽度过渡是错的：抽屉要固定宽度滑出，不是慢慢变宽')

  const shut = ruleBody('.wz-drawer-left .wz-drawer-panel')
  assert.ok(shut && /translateX\(-100%\)/.test(shut),
    '收起时左抽屉整体左移出视口，只留把手（把手单独贴在视口左缘）')
  const open = ruleBody('.wz-drawer-left.is-open .wz-drawer-panel')
  assert.ok(open && /translateX\(0\)/.test(open), '展开时回到原位')
})

test('中栏占满剩下的宽度，内容对齐平台的大容器', () => {
  const body = ruleBody('.wz-stage-main')
  assert.ok(body, 'editor.css 里没有 .wz-stage-main')
  assert.ok(/flex:\s*1/.test(body), '中栏必须 flex:1 撑满剩余宽度')
  assert.ok(/min-width:\s*0/.test(body), '中栏要 min-width:0，否则长路径会撑破布局')

  const inner = ruleBody('.wz-stage-main-inner')
  assert.ok(inner, 'editor.css 里没有 .wz-stage-main-inner')
  assert.ok(/max-width:\s*1400px/.test(inner),
    '中栏内容应当对齐平台的大容器（.workspace-container 的 1400px）')
  assert.ok(/margin:\s*0 auto/.test(inner), '中栏内容应当居中')
})

test('抽屉上面不许盖遮罩（中栏要照常能点、能填表、能接拖拽）', () => {
  // 遮罩的作用是盖住中栏、点它就收起抽屉。
  // 但这三样东西是同时用着的：左边扫参、中间填表、右边看预览。
  // 遮罩一盖上，中栏就点不动了，点中栏还会把抽屉收回去
  // ⇒ 一打开抽屉，表单就废了，参数也没法拖到中栏。
  //
  // 抽屉的开合只由边条上的箭头（开）与 ×（收）控制。
  assert.ok(!ruleBody('.wz-stage-scrim'),
    'editor.css 里还有 .wz-stage-scrim：遮罩会挡住中栏，'
    + '打开抽屉后中栏点不动，点中栏还会收起抽屉')
  assert.ok(!/wz-stage-scrim/.test(stage),
    'Stage.jsx 里还在渲染遮罩：中栏会被挡住，点中栏还会收起抽屉')
  assert.ok(!/wz-stage-scrim/.test(page),
    'ManifestPage.jsx 里还有遮罩')

  // 窄屏降级里也不许把抽屉变成盖住中栏的浮层：
  // 那样中栏被盖掉一半，也点不到。
  const media = css.match(/@media\s*\(max-width:\s*960px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(media, 'editor.css 里没有 960px 的降级规则')
  assert.ok(!/position:\s*absolute/.test(media[1]),
    '960px 以下抽屉不该浮在中栏上面：那样中栏被盖掉一半，也点不到')
})

test('第 4 步不套平台的紫框详情框（.node-detail）', () => {
  // .node-detail 是平台训练页的详情框：border + border-radius + background。
  // 第 4 步的骨架是页面自己的三根骨头，套进去就是「拿页面骨架当卡片内容塞」：
  // 边框套边框、圆角套圆角，页面还多出一层内缩。
  //
  // .node-detail 是训练页的紫框卡片：accent 边框、14px 裸内边距、span 标题。
  // 向导五步统一成「页面 + .section」，所以整个向导都不该再用它。
  // 1/2/3 的步骤卡直接复用平台的三件套，不另抄一份 surface/border/radius。
  assert.ok(app.indexOf('className="node-detail"') < 0,
    '向导里又用上平台的 .node-detail 紫框了：那会和 4/5 步的 section 语言打架')
  assert.ok(/<StepCard\b/.test(app),
    '1/2/3 的步骤卡要走共享的 StepCard，不要另造一套卡片')
  assert.ok(/className="wz-manifest-shell"/.test(app), '第 4 步要有自己的全宽外壳')
})

test('第 4 步在 App.jsx 里是单独一支，自己带外壳', () => {
  assert.ok(/mounted\('manifest'\) && \(/.test(app),
    'App.jsx 里找不到第 4 步的独立分支')
  assert.ok(/className="wz-manifest-shell"/.test(app),
    '第 4 步该有自己的外壳 .wz-manifest-shell')
  // 那一支里渲染的是 ManifestPage，不经过 fieldset。
  const branch = app.slice(app.indexOf("mounted('manifest') && ("))
  const end = branch.indexOf('</div>\n      )}')
  const head = branch.slice(0, end > 0 ? end : 800)
  assert.ok(head.includes('<ManifestPage'), '第 4 步那一支里没有渲染 ManifestPage')
  assert.ok(!head.includes('<fieldset'), '第 4 步那一支里还套着 fieldset')
})

test('五步共用同一张 StepCard，不许各自复制大框', () => {
  // way（起因是大框写了四份）：大框只许一处定义，
  // 其余步骤引用它。只守「只有一份」这条约束，不守框里用了哪些类名。
  const editorFiles = fs.readdirSync(EDITOR).filter((f) => f.endsWith('.jsx'))
  const definers = []
  for (const f of editorFiles) {
    const src = fs.readFileSync(path.join(EDITOR, f), 'utf8')
    // 「定义大框」= 这个文件里写出了 .section + wz-step-card 的组合
    if (/className="section wz-step-card"/.test(src)) definers.push(f)
  }
  assert.ok(definers.length === 1,
    `大框只许一处定义，实际有 ${definers.length} 处：${definers.join(', ')}`)
  assert.ok(definers[0] === 'StepCard.jsx',
    `大框要定义在 StepCard.jsx，实际在 ${definers[0]}`)
  // 其余三个宿主文件必须引用它，不许自己再写一份
  const app = fs.readFileSync(path.join(EDITOR, 'App.jsx'), 'utf8')
  const page = fs.readFileSync(path.join(EDITOR, 'ManifestPage.jsx'), 'utf8')
  const verify = fs.readFileSync(path.join(EDITOR, 'StepVerify.jsx'), 'utf8')
  for (const [name, src] of [['App', app], ['ManifestPage', page], ['StepVerify', verify]]) {
    assert.ok(/<StepCard\b/.test(src), `${name} 要用共享的 StepCard，不许自己复制大框`)
  }
})

test('中栏宽度不随边条变化：边条不占中栏宽度', () => {
  // way：边条无论收展、无论挂几根，中栏宽度与位置都不变。
  // 只守「边条不占中栏宽度」这条行为约束：边条必须是零宽的定位锚点，
  // 可见的把手与面板靠绝对定位贴视口边缘，不参与中栏的宽度分配。
  const css = fs.readFileSync(path.join(EDITOR, 'editor.css'), 'utf8')
  const drawer = ruleBody('.wz-drawer')
  assert.ok(drawer, 'editor.css 里没有 .wz-drawer')
  assert.ok(/flex:\s*0\s+0\s+0/.test(drawer),
    '边条要零宽（flex:0 0 0）：占宽度就会把中栏挤窄，中栏宽度不再恒定')
  // 面板是固定宽度滑出，不靠改宽度换空间
  const panel = ruleBody('.wz-drawer-panel')
  assert.ok(panel, 'editor.css 里没有 .wz-drawer-panel')
  assert.ok(/transition:\s*transform/.test(panel),
    '面板展开动画只能动 transform：宽度过渡会每帧重排中栏')
  assert.doesNotMatch(panel, /transition:[^;]*width/,
    '宽度过渡是错的：抽屉要固定宽度滑出，不是慢慢变宽')
})

test('骨架层不画自己的边框与底色（不许套娃）', () => {
  // 骨架层只是排版：flex 行 + 三根骨头。
  // 任何 border / border-radius / background 加在这一层，
  // 就是「拿一个带紫色描边的巨型棺材盒把三栏硬塞进去」。
  for (const sel of ['.wz-stage', '.wz-stage-main', '.wz-stage-main-inner']) {
    const body = ruleBody(sel)
    assert.ok(body, 'editor.css 里没有 ' + sel)
    assert.ok(!/border/.test(body), sel + ' 不许有 border：边框套边框就是套娃')
    assert.ok(!/border-radius/.test(body), sel + ' 不许有圆角')
    assert.ok(!/background/.test(body), sel + ' 不许有自己的底色')
  }
  assert.ok(!/\.wz-stage\s*\{[^}]*border/.test(css),
    '.wz-stage 又带上边框了')
})

test('没有吸底的存盘栏：保存在中栏身份条上', () => {
  assert.ok(!/wz-savebar-row/.test(css), 'editor.css 里不该再有 .wz-savebar-row')
  assert.ok(!/SaveBar/.test(page), '名片页不该再挂 SaveBar')
  const identity = fs.readFileSync(path.join(EDITOR, 'EngineIdentity.jsx'), 'utf8')
  assert.ok(/t\('Save', '保存'\)/.test(identity), '保存按钮在身份条上，叫「保存」')
})

test('三栏铺满页面：第 4 步不在 .workspace-container 里', () => {
  const manifestAt = app.indexOf("mounted('manifest') && (")
  const branch = app.slice(manifestAt)
  const before = app.slice(0, manifestAt)
  // 第 4 步那一支之前，最近打开的 workspace-container 已经关上了。
  const opens = (before.match(/className="workspace-container/g) || []).length
  const closesAfterLastOpen = before.slice(before.lastIndexOf('className="workspace-container')).includes('</div>')
  assert.ok(opens >= 1 && closesAfterLastOpen, '第 4 步的外壳不该套在 1400px 的居中容器里')
  assert.ok(/className="wz-manifest-shell"/.test(branch))
})

test('顶栏、流程条与其余四步撑满容器宽度（不被 flex 收缩压窄）', () => {
  // .wz-root 是竖排 flex，.workspace-container 带 margin: 0 auto；
  // 不显式 width:100% 的话它按内容收缩，整个向导被压成一条窄栏（#11 的回归）。
  assert.ok(/className="wz-root"/.test(app), '最外层是 .wz-root')
  const body = ruleBody('.wz-root > .workspace-container')
  assert.ok(body, 'editor.css 里没有 .wz-root > .workspace-container')
  assert.ok(/width:\s*100%/.test(body), '.wz-root 里的 .workspace-container 必须 width:100%')
})

test('预览可拖动改宽，也能全屏', () => {
  const stage = fs.readFileSync(path.join(EDITOR, 'Stage.jsx'), 'utf8')
  assert.ok(/className="wz-drawer-resizer"/.test(stage), '预览左边缘要有分隔条')
  assert.ok(/role="separator"/.test(stage), '分隔条要是 separator，键盘能聚焦')
  assert.ok(/onPointerDown=\{onResizeStart\}/.test(stage), '分隔条要能拖')
  assert.ok(ruleBody('.wz-drawer-resizer'), 'editor.css 里没有 .wz-drawer-resizer')
  const full = ruleBody('.wz-drawer.is-open.is-full .wz-drawer-panel')
  assert.ok(full, 'editor.css 里没有全屏规则')
  assert.ok(/position:\s*fixed/.test(full) && /inset:\s*0/.test(full), '全屏要铺满视口')
  assert.ok(!/is-wide/.test(css), '旧的「放大」那一档到不了全屏，应当去掉')
})

test('预览的实际宽度由 CSS 按当前几何封顶：左抽屉后开也给中栏留 320px', () => {
  // 只在拖的那一刻用 JS 夹一次 ⇒ 先拖到最宽、再开左抽屉，中栏被压成 0px（#12 review）。
  // 上限必须写在 CSS 里，按「视口宽 − 左边条此刻宽 − 中栏最小宽」每帧算。
  const cap = ruleBody('.wz-drawer-right.is-open .wz-drawer-panel')
  assert.ok(cap, 'editor.css 里没有 .wz-drawer-right.is-open .wz-drawer-panel 的上限')
  assert.ok(/max-width:[^;]*100vw\s*-\s*var\(--wz-left-w/.test(cap),
    '预览 max-width 要减去 --wz-left-w（左边条此刻的宽度）；面板在一条边条里，百分比指不到整页')
  assert.ok(/var\(--wz-center-min/.test(cap), '预览 max-width 要减去中栏最小宽')
  const stage = ruleBody('.wz-stage')
  assert.ok(/--wz-left-w:\s*var\(--wz-rail-w/.test(stage), '.wz-stage 上要有 --wz-left-w 收着那一档')
  const m = /--wz-center-min:\s*(\d+)px/.exec(stage)
  assert.ok(m, '.wz-stage 上要定义 --wz-center-min')
  const { CENTER_MIN } = require(path.join(EDITOR, 'drawerWidth.js'))
  assert.strictEqual(Number(m[1]), CENTER_MIN, 'CSS 的 --wz-center-min 与 drawerWidth.js 的 CENTER_MIN 不一致')
  const open = ruleBody('.wz-stage-left-open')
  assert.ok(open && /--wz-left-w:\s*var\(--wz-drawer-w/.test(open),
    '.wz-stage-left-open 上要把 --wz-left-w 换成抽屉那一档')
  const full = ruleBody('.wz-drawer.is-open.is-full .wz-drawer-panel')
  assert.ok(/max-width:\s*none/.test(full), '全屏不受预览上限约束')
})

test('两根边条是页面里的柱子：sticky 跟着内容走，不是挂在视口上的浮层', () => {
  // fixed 会把边条从页面结构里摘出去：它的参照是浏览器视口，不是页面。
  //   症状一：top:0 让它一进来就压在顶栏与流程条上（关闭按钮、流程条第 5 个点被盖）。
  //   症状二：页面往下滚，卡片走了、边条钉在原处，两者当场脱开。
  // sticky 的参照是它自己在文档流里的位置：滚到顶才钉住，钉之前和卡片一起排。
  const body = ruleBody('.wz-drawer')
  assert.ok(/position:\s*sticky/.test(body), '边条要在文档流里用 sticky')
  assert.doesNotMatch(body, /position:\s*fixed/,
    'fixed 是视口浮层：边条会脱离页面结构，压住顶栏并在滚动时与卡片脱开')
  assert.ok(/top:\s*0/.test(body), '滚到顶时钉住')
  assert.ok(/height:\s*calc\(100vh - var\(--wz-stage-top/.test(body),
    '边条高度按「视口高 − 骨架起点」算：取满 100vh 会让底部超出视口，'
    + 'sticky 的可吸附范围也被压成「骨架高 − 100vh」，滚两下就被容器顶出去')
  assert.ok(/align-self:\s*flex-start/.test(body),
    'sticky 元素要贴 flex 行顶部，不许被 align-items: stretch 拉成整列高')
  // 左右各自的溢出方向交给面板：aside 自己只是 flex 行里的第一根 / 最后一根柱子。
  const left = ruleBody('.wz-drawer-left .wz-drawer-panel')
  assert.ok(left && /left:\s*0/.test(left), '左抽屉的面板从边条左边展开')
  const right = ruleBody('.wz-drawer-right .wz-drawer-panel')
  assert.ok(right && /right:\s*0/.test(right), '右抽屉的面板从边条右边展开')
})

test('左栏展开不挤中栏：aside 零宽，抽屉是贴在视口边缘的面板', () => {
  // 三层分工，缺一层都会退回「展开就把表单挤窄」：
  //   .wz-drawer        flex: 0 0 0，零宽不占中栏，只是贴边缘的 sticky 定位锚点
  //   .wz-drawer-panel  绝对定位，展开时贴视口左缘溢出到中栏之上，不参与宽度分配
  //   .wz-stage         中栏 flex:1 独占整行，永远满宽
  const drawer = ruleBody('.wz-drawer')
  assert.ok(/flex:\s*0 0 0/.test(drawer),
    'aside 零宽不占中栏，开不开都不从中栏宽度里抢 32px')
  const panel = ruleBody('.wz-drawer-panel')
  assert.ok(panel && /position:\s*absolute/.test(panel),
    '展开的面板要绝对定位：它溢出到中栏之上，不参与宽度分配')
  const open = ruleBody('.wz-drawer-left.is-open .wz-drawer-panel')
  assert.ok(open && /background:/.test(open),
    '左抽屉展开要自带底色：下面压着的是中栏的表单，透上来就读不下去了')
})

test('窄屏降级：960px 以下抽屉收窄到 280px', () => {
  // 中栏宽度不随开合变化；窄屏只把抽屉面板收窄，
  //   免得一块 392px 的抽屉在 960px 的屏上吃掉一半。
  const media = css.match(/@media\s*\(max-width:\s*960px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(media, 'editor.css 里没有 960px 的降级规则')
  assert.match(media[1], /--wz-drawer-w:\s*var\(--wz-drawer-w-narrow/,
    '960px 以下把抽屉那一档换成 var(--wz-drawer-w-narrow)（默认 280px）；'
    + '面板宽度恒定，换的是变量而不是展开态的 width')
  assert.match(media[1], /--wz-left-w:\s*var\(--wz-drawer-w-narrow/,
    '窄屏下预览的宽度上限也要按窄档算')
})

test('骨架那一层不画自己的栏头与外壳', () => {
  // 主界面里每一块内容都是 .section（.section-hdr + .section-body），
  // 而 .workspace-left / .workspace-right 本身没有边框也没有背景，
  // 只是定位用的列（web/src/styles.css:431-469、:578-587）。
  //
  // 骨架层若自己造栏头（wz-zone-hdr 之类），
  // 页面就变成三块互不相干的板子，而不是主界面那种「内容自然铺开」。
  assert.ok(!/wz-zone-hdr|wz-zone-title|wz-zone-body/.test(stage),
    '骨架那一层又造了自己的栏头：栏头该由内容的 .section-hdr 带')
  assert.ok(!/\.wz-zone/.test(css),
    'editor.css 里还有 .wz-zone 系列的样式：那套自制栏头已经退役了')
  assert.ok(!/\.wz-three-zone/.test(css),
    'editor.css 里还有 .wz-three-zone：旧的三列 grid 骨架已经退役了')
  assert.ok(!fs.existsSync(path.join(EDITOR, 'ThreeZone.jsx')),
    'editor/ThreeZone.jsx 还在：旧的骨架文件已经退役了')
})

test('骨架层用平级的 aside 与 main，不套项目的列容器', () => {
  // 三根骨头是页面自己的骨架，不是「某张卡片的三个格子」。
  // 项目现成的 .workspace-left / .workspace-right 是两列 grid 里的定位列，
  // 用在这里会让人以为骨架还是「并排三栏」。
  assert.ok(/<aside/.test(stage), '两根边条该是 aside')
  assert.ok(/<main/.test(stage), '中栏该是 main')
  assert.ok(!stage.includes('workspace-left'), '骨架层不该再用 .workspace-left')
  assert.ok(!stage.includes('workspace-right'), '骨架层不该再用 .workspace-right')
})

test('滚动条槽位恒定（内容跨过滚动临界点时居中列不横移）', () => {
  // 内容跨过滚动临界点时，滚动条占位使可用宽度少 10px，居中列左移 5px。
  // scrollbar-gutter: stable 让槽位恒定，可用宽度不再随内容高度变。
  // 这里只查「规则存在」，真正的判据是「不同内容高度下居中列左右边缘一致」，
  // 那需要起浏览器量 DOM，属于集成测试，不在本静态文件里。行为化测试待补。
  const css = fs.readFileSync(path.join(EDITOR, 'editor.css'), 'utf8')
  const rule = css.match(/html\s*\{([^}]*)\}/)
  assert.ok(rule, 'editor.css 里要有 html 规则来固定滚动条槽位')
  assert.ok(/scrollbar-gutter:\s*stable/.test(rule[1]),
    'html 上要 scrollbar-gutter: stable：否则内容一跨过滚动临界点，居中列就横移半条滚动条')
})
