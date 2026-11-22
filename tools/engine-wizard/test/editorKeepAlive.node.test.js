// 五步常驻：切页只换显隐，不卸载组件。
//
// 守的是「跨步骤状态一致」的结构前提。条件渲染（page === 'env' && <StepDeps/>）
// 在切走时把子树整个卸载，组件内的下载进度、SSE 订阅、日志尾巴、输入内容
// 一并归零，回来只能靠「先写会话段、挂载时再读回来」补，补不齐就是丢进度。
// 所以这里不许退回条件渲染：一旦退回，那条补丁链又得重写一遍。
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { test } = require('node:test')

const EDITOR = path.join(__dirname, '..', 'editor')
const app = fs.readFileSync(path.join(EDITOR, 'App.jsx'), 'utf8')

const KEYS = ['prepare', 'env', 'models', 'manifest', 'verify']

test('五步都是「挂过就常驻 + 显隐切换」', () => {
  for (const key of KEYS) {
    assert.match(app, new RegExp(`mounted\\('${key}'\\) && \\(`),
      `第 ${key} 步应当写作 mounted('${key}') && (…)`)
    assert.match(app, new RegExp(`style=\\{shown\\('${key}'\\)\\}`),
      `第 ${key} 步应当用 shown('${key}') 控制显隐`)
  }
})

test('没有哪一步退回条件渲染', () => {
  for (const key of KEYS) {
    assert.doesNotMatch(app, new RegExp(`\\{page === '${key}' && \\(`),
      `第 ${key} 步退回条件渲染了：切走即卸载，组件内状态归零`)
    assert.doesNotMatch(app, new RegExp(`page && page !== 'manifest'`),
      '1/2/3 那一支又按 page 判定是否渲染了')
  }
})

test('挂载集合只增不减，隐藏是真隐藏而不是不渲染', () => {
  assert.match(app, /cur\.includes\(page\) \? cur : \[\.\.\.cur, page\]/,
    '访问过的步骤必须留在挂载集合里，不能移出')
  assert.match(app, /const shown = \(key\) => \(page === key \? undefined : \{ display: 'none' \}\)/,
    '隐藏要用 display:none：子树保留，定时器与订阅继续跑')
})

test('常驻之后逃生口的 id 不撞', () => {
  // 第 1-3 步共用一个（默认 id），第 5 步一个；两处同时在 DOM 里。
  assert.match(app, /domId="wz-escape-pick-verify"/,
    '第 5 步的逃生口要指定独立 domId，否则与 1-3 步的重复')
  const hatch = fs.readFileSync(path.join(EDITOR, 'EngineEscapeHatch.jsx'), 'utf8')
  assert.match(hatch, /const pickId = domId \|\| 'wz-escape-pick'/,
    '逃生口要能接受外层指定的 domId')
})

test('收起态在 1/2/3 容器之外', () => {
  // page 为空时 1/2/3 那一支被 basicShown 隐藏，收起态若在它里面就永远看不见。
  // 五步统一走 Stage 后，收起态自己是独立的一支 Stage，不再借 workspace-container。
  const idle = app.slice(app.indexOf('{!page && ('))
  assert.ok(/<Stage[\s\S]*center=/.test(idle),
    '收起态要自己走一个 Stage 骨架，不寄生在 1/2/3 的隐藏容器里')
  const before = app.slice(0, app.indexOf('{!page && ('))
  assert.ok(before.lastIndexOf('{basicMounted && (') < before.lastIndexOf('</div>'),
    '收起态仍被包在 1/2/3 的容器里')
})

test('引擎目录清单只有 App 一份，其余步骤从 props 收', () => {
  // 五步认的必须是同一份清单。各自 useEngineDirs 时每份只在挂载时取一次，
  //   克隆或保存后只有调用了自己那份 reload 的步骤刷新，
  //   于是「别处认得新引擎、第 4 步认不得」。
  const src = (f) => fs.readFileSync(path.join(EDITOR, f), 'utf8')
  assert.match(src('App.jsx'), /useEngineDirs\(\)/,
    'App 应当持有这一份清单')
  for (const f of ['EngineIdentity.jsx', 'StepPrepare.jsx']) {
    assert.doesNotMatch(src(f), /useEngineDirs/,
      `${f} 又自己取了一份，会与其余步骤不同步`)
  }
  // App 把它传下去，ManifestPage 再转给身份条。
  assert.match(src('App.jsx'), /dirs=\{engineDirs\} onDirsReload=\{reloadDirs\}/,
    'App 没把清单与刷新回调传给第 4 步')
  assert.match(src('ManifestPage.jsx'), /dirs=\{dirs\} onDirsReload=\{onDirsReload\}/,
    'ManifestPage 没把清单转给身份条')
})

test('第 4 步在共用清单之上多判名片有没有写好', () => {
  // 第 4 步比其余步骤多一层语义：同一台引擎，没名片显示「新建名片」，
  //   盘上有名片但还没读进来显示「读取参数」；下拉项也标「尚无名片」。
  //   这层靠 dirs 项里的 manifestPresent，不是另取一份清单。
  //   名片就位之后身份条不再有动作按钮：「扫描参数」移到中栏「调用方式」旁边。
  const id = fs.readFileSync(path.join(EDITOR, 'EngineIdentity.jsx'), 'utf8')
  assert.match(id, /selectedDir\.manifestPresent === true/,
    '没用 manifestPresent 判名片是否已写好')
  assert.match(id, /const needsCreate = !hasManifest/,
    '没名片的引擎要能新建名片，而不是给一个没有写回之处的「扫描参数」')
  assert.match(id, /const needsRead = hasManifest && !loaded/,
    '有名片但没读进来时要给「读取参数」')
  assert.match(id, /no manifest yet/, '下拉项没标「尚无名片」')
})

test('第 5 步的机械式检验同框：详细项在前，结论在后，证据可折叠', () => {
  // 两块都是机器自动跑出来的静态检查，与「语音合成可用性」（要人手填文本、
  //   点合成）不是一回事，所以收在同一个大框里、与合成那块分开。
  //   顺序固定为「先证据、后结论」，证据默认收起不占首屏。
  const verify = fs.readFileSync(path.join(EDITOR, 'StepVerify.jsx'), 'utf8')
  const overview = verify.indexOf("t('Verification overview', '校验结论')")
  const detailed = verify.indexOf("t('Detailed checks', '详细校验项')")
  const title = verify.indexOf("t('Engine runtime checks', '引擎运行环境检验')")
  const speech = verify.indexOf("t('Speech synthesis', '语音合成可用性')", overview)
  assert.ok(title >= 0, '缺「引擎运行环境检验」这个大框标题')
  assert.ok(detailed > title && overview > detailed,
    '顺序要按大框标题 → 详细校验项 → 校验结论')
  assert.ok(speech > overview, '语音合成可用性要在机械式检验之后单独成框')
  assert.match(verify, /useState\(saved\.checksOpen === true\)/,
    '详细校验证据要保留可折叠，且默认收起')
})
