'use strict'
// 第 3 步界面的守卫：确认界面真的接上了并发执行器与取消端点。
//
// 这份守的是「接线」这一层。执行器与端点各自有测试，但接线错了测试管不着：
//   界面自己写了个串行循环（执行器白做）、忘了调取消端点（按钮按了没反应）、
//   并发数写死成 1（执行器的上限形同虚设），这些都只有读界面源码才看得出来。
//
// 判据用源码里的具体调用，不靠注释：注释会骗人，调用不会。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR_DIR = path.join(__dirname, '..', 'editor')
const SRC = fs.readFileSync(path.join(EDITOR_DIR, 'StepsExtra.jsx'), 'utf8')

test('界面调用并发执行器，不是自己写串行循环', () => {
  assert.match(SRC, /import\s*\{[^}]*downloadFiles[^}]*\}\s*from\s*'\.\/downloadRunner'/,
    '应当从 downloadRunner 引入 downloadFiles')
  assert.match(SRC, /downloadFiles\(\{/,
    '应当真的调用 downloadFiles')
  // 界面里不该再有「等当前文件下载完成后再下载下一个」这种串行写法
  assert.doesNotMatch(SRC, /checkDone\s*=\s*setInterval/,
    '界面里不该再有 setInterval 轮询等上一个下完的串行循环')
})

test('界面用执行器的并发上限，不是写死的数字', () => {
  assert.match(SRC, /import\s*\{[^}]*DEFAULT_CONCURRENCY[^}]*\}\s*from\s*'\.\/downloadQueue'/,
    '应当引入 DEFAULT_CONCURRENCY')
  assert.match(SRC, /concurrency:\s*DEFAULT_CONCURRENCY/,
    '传给执行器的并发数应当是 DEFAULT_CONCURRENCY，不是写死的数字')
})

test('界面上有取消按钮，且它真的打取消端点', () => {
  assert.match(SRC, /fetch\('\/wizard\/download\/cancel'/,
    '取消应当打 /wizard/download/cancel')
  assert.match(SRC, /onClick=\{cancelDownload\}/,
    '应当有按钮调用 cancelDownload')
  assert.match(SRC, /t\('Cancel',\s*'取消'\)/,
    '界面上应当有「取消」文案')
})

test('取消与暂停是两件不同的事，界面文案要说清楚', () => {
  assert.match(SRC, /onClick=\{pauseDownload\}/, '应当有暂停按钮')
  assert.match(SRC, /stage === 'cancelled'/, '应当能显示已取消的状态')
  // 暂停的说明必须写清楚「在当前文件完成后生效」，不写就是欺骗使用者
  assert.match(SRC, /暂停将在当前/,
    '暂停的说明必须写清楚它在当前文件完成后才生效')
})

test('进度按文件分槽，不再是单一全局进度', () => {
  assert.match(SRC, /const \[dlFiles,\s*setDlFiles\]\s*=\s*React\.useState/,
    '应当有按文件分槽的进度表 dlFiles')
  assert.doesNotMatch(SRC, /const \[dlProgress,\s*setDlProgress\]/,
    '单一的全局进度应当已经不存在了')
  assert.match(SRC, /dlEntries/,
    '界面应当从分槽表里取出条目来渲染')
})

test('死代码已删：界面不再走执行上游命令的那条路', () => {
  // 原来界面里有一段「跑上游下载命令」的分支，条件恒假、永远走不到。
  //   它留着会让后来人以为第 3 步有两条下载路径。
  assert.doesNotMatch(SRC, /fetch\('\/wizard\/download',/,
    "界面不该再调 /wizard/download（执行上游命令那条路是死代码）")
})

// 变异检查：把并发执行器的 import 去掉，守卫必须变红。
//   守卫测试自己也会坏：改坏了实现还照样绿的守卫等于没有守卫。
test('变异检查：去掉执行器的 import 后第一条断言会变红', () => {
  const mutated = SRC.replace(
    /import\s*\{[^}]*downloadFiles[^}]*\}\s*from\s*'\.\/downloadRunner'/,
    '')
  assert.notStrictEqual(mutated, SRC, '变异用的正则应当真的改动了源码')
  assert.doesNotMatch(
    mutated,
    /import\s*\{[^}]*downloadFiles[^}]*\}\s*from\s*'\.\/downloadRunner'/,
    '去掉 import 后这一条应当报红')
})
