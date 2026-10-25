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
    '.wz-manifest-layout 必须是竖排：三栏一行，SaveBar 另起一行')
})

test('骨架层是 flex 行：两根边条 + 中栏，三者平级', () => {
  const body = ruleBody('.wz-stage')
  assert.ok(body, 'editor.css 里没有 .wz-stage')
  assert.ok(/display:\s*flex/.test(body), '.wz-stage 必须是 flex 行')
  assert.ok(!/display:\s*grid/.test(body),
    '.wz-stage 要是 grid，就又变成三列并排的板子了')
})

test('边条默认 32px，展开 360px：窄边 + 抽屉，不是三列 grid', () => {
  const body = ruleBody('.wz-drawer')
  assert.ok(body, 'editor.css 里没有 .wz-drawer')
  assert.ok(/width:\s*var\(--wz-rail-w,\s*32px\)/.test(body),
    '边条默认宽度应当是 32px（Owner 指定的窄边宽度）')
  assert.ok(/flex-shrink:\s*0/.test(body), '边条不许被压窄')

  const open = ruleBody('.wz-drawer.is-open')
  assert.ok(open, 'editor.css 里没有 .wz-drawer.is-open')
  assert.ok(/width:\s*var\(--wz-drawer-w,\s*360px\)/.test(open),
    '抽屉展开宽度应当是 360px')
})

test('中栏占满剩下的宽度，内容另有上限', () => {
  const body = ruleBody('.wz-stage-main')
  assert.ok(body, 'editor.css 里没有 .wz-stage-main')
  assert.ok(/flex:\s*1/.test(body), '中栏必须 flex:1 撑满剩余宽度')
  assert.ok(/min-width:\s*0/.test(body), '中栏要 min-width:0，否则长路径会撑破布局')

  const inner = ruleBody('.wz-stage-main-inner')
  assert.ok(inner, 'editor.css 里没有 .wz-stage-main-inner')
  assert.ok(/max-width:\s*960px/.test(inner),
    '中栏内容的宽度上限应当是 960px（Owner 指定的呼吸感）')
  assert.ok(/margin:\s*0 auto/.test(inner), '中栏内容应当居中')
})

test('遮罩不许盖住抽屉（抽屉里的按钮要能点）', () => {
  // 遮罩是 position:fixed 的固定层。边条若不自己抬 z-index，
  // 就会被遮罩盖住：抽屉看着开着，里面的按钮却点不动
  // （点到的其实是遮罩 ⇒ 抽屉立刻收回去）。
  const scrim = ruleBody('.wz-stage-scrim')
  assert.ok(scrim, 'editor.css 里没有 .wz-stage-scrim')
  const scrimZ = Number((scrim.match(/z-index:\s*(\d+)/) || [])[1])
  assert.ok(Number.isFinite(scrimZ), '.wz-stage-scrim 没写 z-index')

  const drawer = ruleBody('.wz-drawer')
  assert.ok(drawer, 'editor.css 里没有 .wz-drawer')
  const drawerZ = Number((drawer.match(/z-index:\s*(\d+)/) || [])[1])
  assert.ok(Number.isFinite(drawerZ), '.wz-drawer 没写 z-index')
  assert.ok(drawerZ > scrimZ,
    `边条的 z-index（${drawerZ}）必须大于遮罩的（${scrimZ}），`
    + '否则抽屉里的按钮点到的是遮罩')
  assert.ok(/position:\s*relative/.test(drawer),
    '.wz-drawer 要 position:relative，z-index 才有意义')
})

test('第 4 步不套平台的紫框详情框（.node-detail）', () => {
  // .node-detail 是平台训练页的详情框：border + border-radius + background。
  // 第 4 步的骨架是页面自己的三根骨头，套进去就是「拿页面骨架当卡片内容塞」：
  // 边框套边框、圆角套圆角，页面还多出一层内缩。
  //
  // 判据：App.jsx 里 .node-detail 那一支的条件必须排除 manifest。
  // 写法不限，但条件里一定要出现 manifest。
  const detailBranch = app.slice(app.indexOf('{page && page !=='))
  assert.ok(detailBranch, 'App.jsx 里找不到 .node-detail 那一支')
  const cond = detailBranch.slice(0, detailBranch.indexOf('('))
  assert.ok(/manifest/.test(cond),
    '.node-detail 那一支没排除 manifest：第 4 步会被套进紫框里，'
    + '条件应当形如 page !== \'manifest\'')
})

test('第 4 步在 App.jsx 里是单独一支，自己带外壳', () => {
  assert.ok(/page === 'manifest' && \(/.test(app),
    'App.jsx 里找不到第 4 步的独立分支')
  assert.ok(/className="wz-manifest-shell"/.test(app),
    '第 4 步该有自己的外壳 .wz-manifest-shell')
  // 那一支里渲染的是 ManifestPage，不经过 fieldset。
  const branch = app.slice(app.indexOf("page === 'manifest' && ("))
  const end = branch.indexOf('</div>\n      )}')
  const head = branch.slice(0, end > 0 ? end : 800)
  assert.ok(head.includes('<ManifestPage'), '第 4 步那一支里没有渲染 ManifestPage')
  assert.ok(!head.includes('<fieldset'), '第 4 步那一支里还套着 fieldset')
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

test('SaveBar 那一行是 sticky 且独立成行（不塞进任何一栏）', () => {
  const body = ruleBody('.wz-savebar-row')
  assert.ok(body, 'editor.css 里没有 .wz-savebar-row')
  assert.ok(/position:\s*sticky/.test(body), 'SaveBar 那一行必须 sticky')
  assert.ok(/bottom:\s*0/.test(body), 'SaveBar 那一行必须吸在底部')
  assert.ok(/className="wz-savebar-row"/.test(page),
    'SaveBar 应当有自己的行，而不是塞进某一栏里')
})

test('窄屏降级：960px 以下抽屉改成覆盖式中栏', () => {
  const media = css.match(/@media\s*\(max-width:\s*960px\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(media, 'editor.css 里没有 960px 的降级规则')
  assert.ok(/\.wz-drawer\.is-open/.test(media[1]),
    '960px 以下抽屉应当改成覆盖式中栏（position:absolute），不然会把它挤没')
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
