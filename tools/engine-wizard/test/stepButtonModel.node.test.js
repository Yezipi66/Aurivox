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
