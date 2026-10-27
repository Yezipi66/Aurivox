'use strict'
// 「引擎配置」里那一行「参考音频时长」要说明为什么值得填。
//
// 为什么要有这条：这一项缺着时平台不检查，填了才拦
// （lib/services/synthesisService.js:131-137 只在 clip 存在时才量 wav 时长）。
// 界面上原来只写「不限制」，使用者不知道填了会挡住什么、为什么该填。
// 要写的理由是三件每个使用者都能理解的事：参考音频越长，特征提取越慢、
// 内存占用越高、首字节延迟越高 ⇒ 这一项值得填。
//
// 判据（都在源码声明上，不渲染 JSX）：
//   ① 时长区间那一项带 noteEn / noteZh 两份文案，且中文说清「越长越慢」这个方向。
//   ② 提示用平台的 .field-note（11px + --muted + opacity 0.8 + 斜体），
//      不自造类：向导 import 了 web/src/styles.css（editor/index.jsx:5），
//      自造一套字号颜色会与平台的字号标度脱钩。
//   ③ 提示里不许出现内部原则与口语（守卫的判据抄 styleguard 的那份）。
//
// 变异检查：把 note 去掉、把类名换掉、把方向说反，上面三条各有一条会红。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const optionalSrc = fs.readFileSync(path.join(EDITOR, 'OptionalConfig.jsx'), 'utf8')
const projectCss = fs.readFileSync(path.join(__dirname, '../../../web/src/styles.css'), 'utf8')

// optionalKeys.js 是 ESM 纯数据文件：用项目 Vite 依赖的同一个 esbuild 编译成 CJS 取导出。
function loadOptionalKeys () {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  assert.ok(esbuild, '拿不到 esbuild，没法读 optionalKeys.js')
  const file = path.join(EDITOR, 'optionalKeys.js')
  const code = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => { throw new Error('optionalKeys.js 不该有依赖') }, mod)
  return mod.exports
}

function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('时长区间那一项带「为什么值得填」的中英文提示', () => {
  const { OPTIONAL_KEYS } = loadOptionalKeys()
  const clip = OPTIONAL_KEYS.find((k) => k.path === 'capabilities.reference_clip_seconds')
  assert.ok(clip, '引擎配置里少了时长区间那一项')
  assert.ok(clip.noteZh && clip.noteEn, '时长区间那一项没写 noteZh / noteEn')
  // 方向：越长越慢。方向说反了比不写更坏。
  assert.ok(/越长/.test(clip.noteZh) && /越慢/.test(clip.noteZh),
    `中文提示没说明「参考音频越长越慢」这个方向：${clip.noteZh}`)
  // 三件事都要在：提取耗时、内存、首字节延迟。
  for (const [word, why] of [['特征提取', '提取耗时'], ['内存', '内存占用'], ['首字节', '首字节延迟']]) {
    assert.ok(clip.noteZh.includes(word), `中文提示没提「${why}」：${clip.noteZh}`)
  }
})

test('提示用平台的 .field-note，不自造类', () => {
  const live = stripComments(optionalSrc)
  assert.ok(/className="field-note"/.test(live),
    '提示没用平台的 .field-note：向导 import 了 web/src/styles.css，自造类会与平台字号标度脱钩')
  // 自造的 wz-opt-note 没有对应样式，是个空类。
  assert.ok(!/wz-opt-note/.test(live), '还有 wz-opt-note 这个自造类：它没有对应样式')
  // .field-note 必须真的比正文暗一号：平台 styles.css 里它是 --fs-11 + --muted + opacity 0.8。
  const rule = /\.field-note\s*\{([^}]*)\}/.exec(projectCss)
  assert.ok(rule, '平台 styles.css 里没有 .field-note')
  assert.ok(/opacity:\s*0\.8/.test(rule[1]),
    '平台的 .field-note 没有变暗：它得比同一行的 .field-hint 更弱一层')
  assert.ok(/font-size:\s*var\(--fs-11\)/.test(rule[1]),
    '平台的 .field-note 不是小一号：它得比正文小一号')
})

test('提示文案里不许出现内部原则与口语', () => {
  const { OPTIONAL_KEYS } = loadOptionalKeys()
  const clip = OPTIONAL_KEYS.find((k) => k.path === 'capabilities.reference_clip_seconds')
  const forbidden = ['平台不替你猜', '平台不会替你猜', '平台不会替你选', '这正是这个页面存在的理由', '——']
  for (const pat of forbidden) {
    assert.ok(!clip.noteZh.includes(pat), `中文提示含「${pat}」`)
    assert.ok(!clip.noteEn.includes(pat), `英文提示含「${pat}」`)
  }
  // 第二人称「你」要改掉。
  assert.ok(!clip.noteZh.includes('你'), `中文提示用了第二人称「你」：${clip.noteZh}`)
})

test('变异检查：把提示去掉、把类名换掉、把方向说反，各有一条会红', () => {
  // ① 去掉 note ⇒ 「时长区间那一项带提示」这条会红。
  const noNote = { noteEn: undefined, noteZh: undefined }
  assert.ok(!(noNote.noteZh && noNote.noteEn), '去掉 note 后判据应当判成不合格')

  // ② 换类名 ⇒ 「用平台的 .field-note」这条会红。
  const wrongClass = 'wz-opt-note'
  assert.ok(!/className="field-note"/.test(`className="${wrongClass}"`),
    '换了自造类名后判据应当判成不合格')

  // ③ 方向说反 ⇒ 「越长越慢」这条会红。
  const reversed = '参考音频越短，特征提取越慢，内存占用越高，首字节延迟也越高。'
  assert.ok(!(/越长/.test(reversed) && /越慢/.test(reversed)),
    '方向说反后判据应当判成不合格')
  // 方向说反的句子仍然包含那三个词 ⇒ 只查词会放过它，所以必须查方向。
  assert.ok(reversed.includes('特征提取') && reversed.includes('内存') && reversed.includes('首字节'),
    '这句反方向的话仍含三个词：说明只查词不够，必须查方向')
})
