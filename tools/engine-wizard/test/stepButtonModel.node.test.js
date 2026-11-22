'use strict'
// editor/StepPrepare.jsx + App.jsx 的按钮心智模型守卫。
//
// 使用者的操作顺序（心智模型）：
//   ① 贴链接 → ② 点「读取仓库信息」→ ③ 读取到，显示仓库信息 →
//   ④ 右下角 [重新读取] [克隆] → ⑤ 克隆完成 → ⑥ [下一步] 跳第 2 步。
// 这条判据失守时的现象：没读取就有「下一步」、读取后还留着「下一步」、
//   克隆完自动跳走（来不及确认）、「下一步」偷偷在做克隆。全都是用户
//   明确纠正过的错位，必须锁住。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const prepSrc = fs.readFileSync(path.join(EDITOR, 'StepPrepare.jsx'), 'utf8')
const appSrc = fs.readFileSync(path.join(EDITOR, 'App.jsx'), 'utf8')

test('「下一步」按钮只跳转、不再克隆（onClick 是 onNext，不是 doClone）', () => {
  assert.ok(/onClick=\{onNext\}/.test(prepSrc),
    '「下一步」按钮的 onClick 不是 onNext：克隆完成后点「下一步」会重复克隆')
  assert.ok(/onClick=\{\(\) => doClone\(true\)\}/.test(prepSrc),
    '克隆按钮丢了（onClick 没调 doClone(true)）：读取后没法克隆')
  // 两个按钮必须都存在于源码里，且是两处不同的 onClick；
  // 若「下一步」又被改回 doClone，上面的 onNext 断言就会抓住。
})

test('克隆按钮只在读取成功后出现（readSomething && !done 门控）', () => {
  // doClone(true) 的调用点必须落在「读取成功、未克隆」那个 JSX 块里：
  // 读取前只有「读取仓库信息」，不该有克隆入口。
  // 判据按块切，不按字符距离：中间的命令区与结果提示一变长，字符窗口就要跟着调，
  //   那种数字迟早会拦下一次无害的排版改动。
  const marker = '{resForCur && resForCur.ok && readSomething && !done && ('
  const after = prepSrc.split(marker)[1] || ''
  const block = after.split('{resForCur &&')[0]
  assert.ok(block.length > 0, '找不到「读取成功、未克隆」那个块的起点：门控被改了')
  assert.ok(/doClone\(true\)/.test(block),
    '克隆按钮没被 readSomething && !done 门控：没读取也能克隆（心智错位）')
})

test('读取按钮三态齐备：读取仓库信息 / 重新读取 / 克隆', () => {
  assert.ok(/t\('Read repository info', '读取仓库信息'\)/.test(prepSrc), '丢了「读取仓库信息」按钮')
  assert.ok(/t\('Re-read repository info', '重新读取'\)/.test(prepSrc), '丢了「重新读取」按钮')
  assert.ok(/t\('Clone', '克隆'\)/.test(prepSrc), '丢了个「克隆」按钮')
  assert.ok(/t\('Next', '下一步'\)/.test(prepSrc), '丢了「下一步」按钮')
})

test('App 的 onDone 克隆完成后不自动跳第 2 步（留给「下一步」按钮）', () => {
  const m = prepSrc && /onDone=\{\(clonedId\) => \{([\s\S]*?)\}\}/.exec(appSrc)
  assert.ok(m, 'App.jsx 里没找到 onDone 回调块')
  assert.ok(!/setPage\s*\(/.test(m[1]),
    'onDone 里还 setPage：克隆完自动跳第 2 步，来不及确认，心智错位')
})

test('App 把 onNext 传给 StepPrepare（下一步按钮负责跳第 2 步）', () => {
  assert.ok(/onNext=\{\(\) => setPage\('env'\)\}/.test(appSrc),
    'App 没把 onNext 传给 StepPrepare：克隆完成后「下一步」无处可去')
})

// 换链接后的读取与克隆必须针对当前输入框，不能用上一次解析的残留：
//   输入 A 却读取/克隆 B，且 B 恰好没有依赖清单时，界面表现为
//   「这个仓库没有任何声明依赖」，而用户明明贴的是有清单的仓库。
//   判据失守的根因是 doProbe/doClone 优先读 state.repoUrl/state.cloneUrl，
//   而输入框 onChange 只更新 wz.url 不清这两个持久段字段。
test('换链接后读取用当前输入、克隆用对应当前输入的 res（不用残留旧值）', () => {
  // doProbe 的请求地址必须取当前输入框的 url，不是 state.repoUrl（残留旧值）。
  assert.ok(/const j = await post\('\/wizard\/probe',\s*\{\s*url: at\s*\}/.test(prepSrc),
    'doProbe 没取当前输入框的地址：换链接后读取会用上一次解析的残留地址')
  // doClone 的 cloneUrl 只能从「对应当前输入」的 res 里取，不留 state.cloneUrl 退路。
  assert.ok(/const resForCur = \(res && res\.input === url\) \? res : null/.test(prepSrc),
    'doClone 没按 res.input === url 过滤：会用过期 res 的 cloneUrl 克隆错仓库')
  assert.ok(/const cloneUrl = \(resForCur && resForCur\.cloneUrl\) \|\| ''/.test(prepSrc),
    'doClone 的 cloneUrl 还有 state.cloneUrl 退路：残留旧地址会把上一个仓库拉进来')
  // 输入框 onChange 改 URL 时必须同时清 repoUrl/cloneUrl。
  assert.ok(/onChange\(\{\s*url: e\.target\.value,\s*repoUrl: '',\s*cloneUrl: ''\s*\}\)/.test(prepSrc),
    'onChange 只写 url 不清 repoUrl/cloneUrl：持久段残留旧上游，读取与克隆会用错')
})

// 显示与使用必须同源：命令区、项目信息区、克隆、路径全从「对应当前输入框」的
// resForCur 取，不许再用裸 res。裸 res 是上次解析的产物，换过链接就过期；
// 用它显示命令会出现「命令是上一个仓库、识别信息是当前仓库」（用户先前见过的
// 现象：命令显示 piper，识别信息却是 Spark TTS）。克隆已按 resForCur 走，
// 显示也必须跟它一致。
test('显示区全部用对应当前输入的 resForCur，不用裸 res', () => {
  // 命令文本：git clone ${resForCur.cloneUrl}，不许是 res.cloneUrl
  assert.ok(/git clone \$\{\(resForCur && resForCur\.cloneUrl\) \|\| ''\}/.test(prepSrc),
    '命令文本用了裸 res.cloneUrl：命令与克隆不同源，会出现「命令是上一个仓库」')
  // 项目信息区门控
  assert.ok(/resForCur && resForCur\.ok && readSomething && \(/.test(prepSrc),
    '项目信息区门控没走 resForCur：会显示过期仓库的信息')
  // 命令区门控
  assert.ok(/resForCur && resForCur\.ok && readSomething && !done/.test(prepSrc),
    '命令区门控没走 resForCur：会显示过期仓库的命令')
  // 已克隆区门控
  assert.ok(/resForCur && resForCur\.ok && done && \(/.test(prepSrc),
    '已克隆区门控没走 resForCur：会显示过期仓库的完成状态')
  // 读取按钮门控：贴完链接就常驻，不等到「读到东西」才出现，也不等输入框失焦。
  //   所以门控不能要求 resForCur.ok（那时还没有解析结果）；
  //   「换链接后不用过期状态」由 readRepo 自己保证：当前输入没解析过就先解析。
  assert.ok(/!done && !!url\.trim\(\) && \(/.test(prepSrc),
    '读取按钮没有在贴完链接后常驻：新用户看不到下一步该点哪儿，也看不到读没读')
  assert.ok(/const readRepo = async \(\) => \{[\s\S]{0,400}?await resolve\(\)[\s\S]{0,200}?await doProbe\(/
    .test(prepSrc),
    '读取按钮必须自己完成解析与探测：否则解析失败时会拿不合法的地址去探测')
  // 目录名与路径
  assert.ok(/const autoId = \(resForCur && resForCur\.ok && resForCur\.repo\) \|\| guessRepoFromUrl\(url\)/.test(prepSrc),
    'autoId 没走 resForCur：换链接后默认目录名取自过期仓库')
  assert.ok(/const enginesDir = \(resForCur && resForCur\.enginesDir\) \|\| null/.test(prepSrc),
    'enginesDir 没走 resForCur：目标路径会拼出过期仓库的目录')
})

// 目录名的两种状态必须分得开：留空 = 跟随链接，有字 = 固定（手写或从候选里选中）。
// 判据失守时的现象：目录名被自动填进输入框，从此与「人写的」不可区分，
//   换链接时名字不再跟着变，克隆落进上一个仓库的目录（已发生过一次）。
test('目录名留空跟随链接：推导值只进 placeholder，不写回输入框', () => {
  assert.ok(/const curId = folderName\(\{ typed: idInput, suggested: autoId \}\)/.test(prepSrc),
    'curId 的取值链变了：目录名必须由「输入框 + 链接推导」得出，不能引入第三来源')
  // 推导值不许写进输入框：写进去就成了「人写的」，换链接也不会再变。
  assert.ok(!/setIdInput\(j\.id\)/.test(prepSrc),
    '解析结果被写进了目录名输入框：它从此无法跟随链接，克隆会落到旧目录')
  assert.ok(/placeholder=\{autoId \|\| 'auto'\}/.test(prepSrc),
    '目录名框没有把推导值显示成灰字：使用者看不到接下来会用哪个名字')
  // 换链接时目录名归零（回到跟随），旧名字不许跨仓库存活。
  // 窗口放宽到 400：中间还有「同步副本」那一行，判据不靠固定字符距离。
  assert.ok(/setUrl\(e\.target\.value\)[\s\S]{0,400}?setIdInput\(''\)/.test(prepSrc),
    '换链接时没有把目录名清回「跟随」：旧名字会留在框里，克隆落进旧目录')
  // 解析请求不带 id：回传输入框的值会让后端把它原样还回来。
  assert.ok(/post\('\/wizard\/resolve', \{ url \}\)/.test(prepSrc),
    '解析请求还带着 id：后端会把旧名字原样返回，目录名被锁死')
})

// 目录名要给「复用已有引擎」留入口：下拉 + 文本框同一套外观（共用 Select 的 editable）。
test('目录名是下拉 + 文本框（editable Select），候选来自 engines/ 下的目录', () => {
  assert.ok(/<Select className="control" editable value=\{idInput\}/.test(prepSrc),
    '目录名不是可编辑下拉：无法从已有引擎里选一台复用')
  // 候选清单与其余四步共用 App 那一份：从 props 收，不再各自取一次。
  //   各自取时刷新时机不同步，克隆完成后这里看不到新目录。
  assert.ok(/onUndone, engineDirs \}\)/.test(prepSrc),
    '目录名候选清单没接 App 传下来的 engineDirs：下拉里没有已有目录可选')
  assert.ok(/<option value="">\{t\('— follow the link —', '跟随链接'\)\}<\/option>/.test(prepSrc),
    '下拉里没有「跟随链接」这一项：选中一个具体目录后无法回到跟随')
})

// 离开链接框 = 点一次「读取仓库信息」。自动动作可以保留，但出口必须齐备：
//   判据失守时的现象：点克隆/下一步时被失焦抢先读一次（和真正的动作抢同一条请求）；
//   同一条链接每点一次空白就读一遍（错误提示一直挂在屏幕上）；
//   读取卡住时只能刷新页面（刷新会把填好的链接与目录名一起丢掉）。
test('离开链接框自动读取一次，三个出口齐备（跳过控件 / 只读一次 / 可停止）', () => {
  assert.ok(/onBlur=\{onUrlBlur\}/.test(prepSrc),
    '链接框没接失焦读取：点空白之后界面不会自己去读，使用者以为已经读过了')

  const blur = /const onUrlBlur = \(e\) => \{([\s\S]*?)\n  \}/.exec(prepSrc)
  assert.ok(blur, 'onUrlBlur 不见了')
  // 出口①：焦点落到本步的控件上就不代劳（那些控件自己会发请求）。
  assert.ok(/const AUTO_READ_SKIP = 'button, a, input, select, textarea, \[role="button"\]'/
    .test(prepSrc), '没有控件跳过清单：失焦会把克隆/下一步的点击抢成一次读取')
  assert.ok(/relatedTarget/.test(blur[1]) && /closest\(AUTO_READ_SKIP\)/.test(blur[1]),
    'onUrlBlur 没按焦点落点过滤：点到本步控件也会自动读一次')
  // 出口②：同一条链接只自动读一次，之后的读取只由按钮发起。
  assert.ok(/resForCur/.test(blur[1]),
    'onUrlBlur 没有「已解析过就不再自动读」的判据：失败之后每点一次空白都重试')
  assert.ok(/readRepo\(\)/.test(blur[1]),
    'onUrlBlur 没走 readRepo：失焦与按钮会走两条不同的路')

  // 出口③：读取期间可以停止（按钮换成「停止读取」，并且真的中止请求）。
  assert.ok(/onClick=\{stopRead\}/.test(prepSrc),
    '读取期间没有停止按钮：读取卡住时使用者只能刷新页面')
  assert.ok(/t\('Stop reading', '停止读取'\)/.test(prepSrc), '停止按钮没有文案')
  const stop = /const stopRead = \(\) => \{([\s\S]*?)\n  \}/.exec(prepSrc)
  assert.ok(stop, 'stopRead 不见了')
  assert.ok(/\.abort\(\)/.test(stop[1]),
    '停止读取没有中止请求：按钮只把状态改回未读取，请求还在后台跑')
  assert.ok(/signal: ctl\.signal/.test(prepSrc),
    '探测请求没带中止信号：停止之后请求仍然在跑')
  // 在途结果不许回写：中止或重新发起之后，旧那一次回来时要对不上号。
  assert.ok(/if \(mySeq !== probeSeq\.current \|\| urlRef\.current !== at\) return/
    .test(prepSrc), '探测结果没判序号与地址：迟到的结果会盖住新一次读取')

  // 同一条读取不许并发（失焦与点击可能落在同一瞬间）。
  assert.ok(/const readRepo = async \(\) => \{[\s\S]{0,200}?if \(busyRef\.current\) return/
    .test(prepSrc), 'readRepo 没有并发守卫：失焦与点击会同时发两条读取')

  // 回车与按钮走同一条路：只做本地解析会让界面看起来像已经探过。
  assert.ok(/onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' && url\.trim\(\) && !busy\) readRepo\(\) \}\}/
    .test(prepSrc), '回车没有走 readRepo：回车只会做本地解析，界面看起来却像已经探过')
})

// 会话段的键是「目录名 + 地址」。解析会把目录名从空变成真名，读取结果必须
//   按「这次解析出来的」那一对写；按当前渲染里那一对写，结果就落进一个随即被
//   丢弃的键，界面表现为「读到了，紧接着又变回没读，再点一次才正常」。
test('读取结果按这次解析出的会话键写入（不写进随即被丢弃的键）', () => {
  assert.ok(/const key = \{ id: resolvedName, url: resolvedUrl \}/.test(prepSrc),
    'resolve 没算这次结果的归属键：目录名从空变成真名时结果会被丢弃')
  assert.ok(/onPrep\(\(w\) => \(\{ \.\.\.w, res: \{ \.\.\.j, input: resolvedUrl \}, probe: null \}\), key\)/
    .test(prepSrc), '解析结果没带键写入：读到的信息会写进旧目录名那一格')
  assert.ok(/const patch = \(k, v, key\) => onPrep\(\(w\) => \(\{ \.\.\.w, \[k\]: v \}\), key\)/
    .test(prepSrc), 'patch 没有键参数：探测与计划无法跟着解析出来的目录名走')
  assert.ok(/const doProbe = async \(key\) => \{[\s\S]{0,120}?const at = key\.url/.test(prepSrc),
    'doProbe 没接收归属键：探测结果会写进旧键')
  assert.ok(/saveSession\(\(key && key\.id\) \|\| wz\.id, \(key && key\.url\) \|\| persistedUrl/
    .test(appSrc), 'App 的 patchPrep 不接受指定键：会话段仍按当前目录名写')
})

// 第 1 步完成状态必须用后端真正提供的键：facts 是 /wizard/install-state 的
// steps_done，只有 prepare/env/models/manifest/verify 五个键，没有 cloned。
// 判据失守时 done 恒 false，克隆完成后「撤销克隆 / 下一步」永远不会出现，
// 使用者被卡在第 1 步；而流程条（steps.js 的 stepDone）用 facts.prepare 判，
// 同一份 facts 两处判据打架，界面自相矛盾。
test('第 1 步完成状态用 cloneDone（与当前目录名同源），不用不存在的 facts.cloned', () => {
  assert.ok(/const done = cloneDone\(\{ facts, factsId, curId \}\)/.test(prepSrc),
    'done 没走 cloneDone：只比 facts.prepare 会把旧引擎的完成状态显示在新仓库上')
  // 只查代码用法（facts.cloned ===），注释里提到这个键名是允许的。
  assert.ok(!/facts\.cloned\s*===/.test(prepSrc),
    '代码里还有 facts.cloned ===：后端只提供五个步骤键，cloned 是死键')
})

// 换链接修复之后不该留下孤儿：声明了没人用 / 与注释矛盾的，都得清掉，
// 免得误导下一个接手的人（以为还能用，实际是死代码）。
test('无孤儿：setRes、relEngineDir 已删，撤销克隆不写孤儿键', () => {
  assert.ok(!/const setRes = /.test(prepSrc),
    'setRes 是孤儿函数（声明了没有任何调用），应删')
  assert.ok(!/const relEngineDir = /.test(prepSrc),
    'relEngineDir 是孤儿变量（声明了没有任何使用），应删')
  assert.ok(!/onChange\(\{ cloned: false \}\)/.test(prepSrc),
    '还写 wz.cloned：持久段没有这个键，是孤儿写入，完成状态只由端点判')
})

// 撤销克隆（第 1 步）后必须重新判完成状态：目录删了 ⇒ facts.prepare 变 false，
// 「已克隆」区收起、回到命令区。判据失守时界面仍停在「已克隆」，下一步还能走。
test('撤销克隆后按被删的那个目录名重新判完成状态', () => {
  assert.ok(/onUndone=\{\(id\) => reloadFacts\(id\)\}/.test(appSrc),
    'App 没按被删的 id 重读：撤销后 facts 还留在上一台，界面与磁盘不一致')
})
