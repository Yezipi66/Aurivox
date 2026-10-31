'use strict'
// editor/StepPrepare.jsx + App.jsx 的按钮心智模型守卫。
//
// 使用者的操作顺序（心智模型）：
//   ① 贴链接 → ② 点「嗅探仓库」→ ③ 嗅探到，显示仓库信息 →
//   ④ 右下角 [重新嗅探] [克隆] → ⑤ 克隆完成 → ⑥ [下一步] 跳第 2 步。
// 这条判据失守时的现象：没嗅探就有「下一步」、嗅探后还留着「下一步」、
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
    '克隆按钮丢了（onClick 没调 doClone(true)）：嗅探后没法克隆')
  // 两个按钮必须都存在于源码里，且是两处不同的 onClick；
  // 若「下一步」又被改回 doClone，上面的 onNext 断言就会抓住。
})

test('克隆按钮只在嗅探成功后出现（readSomething && !done 门控）', () => {
  // doClone(true) 的调用点必须落在「嗅探成功、未克隆」的块里：
  // 嗅探前只有「嗅探仓库」，不该有克隆入口。
  // 门控条件在 doClone(true) 之前约 4.7k 字符处（命令区 + 结果提示夹在中间），窗口留 5k 余量。
  assert.ok(/readSomething\s*&&\s*!done[\s\S]{0,5000}?doClone\(true\)/.test(prepSrc),
    '克隆按钮没被 readSomething && !done 门控：没嗅探也能克隆（心智错位）')
})

test('嗅探按钮三态齐备：嗅探仓库 / 重新嗅探 / 克隆', () => {
  assert.ok(/t\('Sniff repository', '嗅探仓库'\)/.test(prepSrc), '丢了「嗅探仓库」按钮')
  assert.ok(/t\('Resniff repository', '重新嗅探'\)/.test(prepSrc), '丢了「重新嗅探」按钮')
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

// 换链接后的嗅探与克隆必须针对当前输入框，不能用上一次解析的残留：
//   输入 A 却嗅探/克隆 B，且 B 恰好没有依赖清单时，界面表现为
//   「这个仓库没有任何声明依赖」，而用户明明贴的是有清单的仓库。
//   判据失守的根因是 doProbe/doClone 优先读 state.repoUrl/state.cloneUrl，
//   而输入框 onChange 只更新 wz.url 不清这两个持久段字段。
test('换链接后嗅探用当前输入、克隆用对应当前输入的 res（不用残留旧值）', () => {
  // doProbe 的请求地址必须取当前输入框的 url，不是 state.repoUrl（残留旧值）。
  assert.ok(/const j = await post\('\/wizard\/probe',\s*\{\s*url\s*\}\)/.test(prepSrc),
    'doProbe 没取当前输入框的 url：换链接后嗅探会用上一次解析的残留地址')
  // doClone 的 cloneUrl 只能从「对应当前输入」的 res 里取，不留 state.cloneUrl 退路。
  assert.ok(/const resForCur = \(res && res\.input === url\) \? res : null/.test(prepSrc),
    'doClone 没按 res.input === url 过滤：会用过期 res 的 cloneUrl 克隆错仓库')
  assert.ok(/const cloneUrl = \(resForCur && resForCur\.cloneUrl\) \|\| ''/.test(prepSrc),
    'doClone 的 cloneUrl 还有 state.cloneUrl 退路：残留旧地址会把上一个仓库拉进来')
  // 输入框 onChange 改 URL 时必须同时清 repoUrl/cloneUrl。
  assert.ok(/onChange\(\{\s*url: e\.target\.value,\s*repoUrl: '',\s*cloneUrl: ''\s*\}\)/.test(prepSrc),
    'onChange 只写 url 不清 repoUrl/cloneUrl：持久段残留旧上游，嗅探与克隆会用错')
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
  // 嗅探按钮门控
  assert.ok(/resForCur && resForCur\.ok && !done && !readSomething/.test(prepSrc),
    '嗅探按钮门控没走 resForCur：换链接后按钮会用过期状态')
  // 目录名与路径
  assert.ok(/const autoId = \(resForCur && resForCur\.ok && resForCur\.repo\) \|\| guessRepoFromUrl\(url\)/.test(prepSrc),
    'autoId 没走 resForCur：换链接后默认目录名取自过期仓库')
  assert.ok(/const enginesDir = \(resForCur && resForCur\.enginesDir\) \|\| null/.test(prepSrc),
    'enginesDir 没走 resForCur：目标路径会拼出过期仓库的目录')
  // 失焦/回车重新解析的条件也必须是 !resForCur（res 过期非空时也要能重解析）
  assert.ok(/onBlur=\{\(\) => \{ if \(url\.trim\(\) && !resForCur\) resolve\(\) \}\}/.test(prepSrc),
    'onBlur 还在判 !res：res 过期非空时不会重新解析，界面卡在过期状态')
})

// 第 1 步完成状态必须用后端真正提供的键：facts 是 /wizard/install-state 的
// steps_done，只有 prepare/env/models/manifest/verify 五个键，没有 cloned。
// 判据失守时 done 恒 false，克隆完成后「撤销克隆 / 下一步」永远不会出现，
// 使用者被卡在第 1 步；而流程条（steps.js 的 stepDone）用 facts.prepare 判，
// 同一份 facts 两处判据打架，界面自相矛盾。
test('第 1 步完成状态用 facts.prepare，不用不存在的 facts.cloned', () => {
  assert.ok(/const done = facts && facts\.prepare === true/.test(prepSrc),
    'done 用了 facts.cloned：steps_done 没有这个键，done 恒 false，克隆后「下一步」永不出现')
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
test('撤销克隆后重新判完成状态（App 把 reloadFacts 交给 StepPrepare）', () => {
  assert.ok(/onUndone=\{\(\) => reloadFacts\(\)\}/.test(appSrc),
    'App 没把 reloadFacts 给 StepPrepare：撤销后 facts 不刷新，「已克隆」区不收起')
})
