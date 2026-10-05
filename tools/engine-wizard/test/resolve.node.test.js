'use strict'
// resolve（第 1 步）—— ⭐ 判据全部来自 registry.js 的**实际行为**，不是我发明的
//
// ⚠ 这些用例对应平台真实的硬约束：
//   registry.js:83 `_` / `.` 开头被跳过
//   registry.js:59 id 与目录名不一致 ⇒ ENGINE_MANIFEST_ID_MISMATCH
// 一旦 id 定错，后面每一步都在错的目录上干活 ⇒ 这一步错不得。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { parseRepoUrl, suggestId, validateId, resolveEngine } =
  require('../core/resolve.js')

// ---------------------------------------------------------------------------
// 链接解析
// ---------------------------------------------------------------------------
test('三种写法都认得出来', () => {
  const want = { owner: 'acme', repo: 'speech-kit' }
  for (const s of [
    'https://github.com/acme/speech-kit',
    'http://github.com/acme/speech-kit',
    'https://www.github.com/acme/speech-kit',
    'github.com/acme/speech-kit',
    'acme/speech-kit',
    '  https://github.com/acme/speech-kit  ',
  ]) {
    const r = parseRepoUrl(s)
    assert.strictEqual(r.ok, true, `${s} 竟没解析出来`)
    assert.strictEqual(r.repo, want.repo, s)
  }
})

test('⭐⭐ /tree/<branch> ⇒ 归一化到仓库根，并**回报剥掉了什么**', () => {
  for (const u of [
    'https://github.com/acme/speech-kit/tree/main',
    'https://github.com/acme/speech-kit/tree/dev_1.5',
  ]) {
    const r = parseRepoUrl(u)
    assert.strictEqual(r.ok, true, u)
    assert.strictEqual(r.repo, 'speech-kit', u)
    assert.ok(r.trimmedTail, '⛔ 必须回报剥掉了哪一段')
    // ⚠ 2026-10-05 Owner：「你这一句话没有做 i18n」⇒ 后端改成只回 code + params，
  //   中文句子搬到前端 t(en,zh)（StepPrepare 的 ERR_TEXT / TRIMMED_TAIL）。
  assert.strictEqual(r.noteCode, 'TRIMMED_TAIL', '⛔ 归一化告知要走 code，不是中文句子')
  assert.ok(r.noteParams && r.noteParams.tail, '⛔ 必须把剥掉的那段回给界面')
  }
})

test('⭐⭐ 无域名的 owner/repo/tree/branch 也要能用（贪方便复制的那种）', () => {
  const r = parseRepoUrl('acme/speech-kit/tree/main')
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.repo, 'speech-kit')
  assert.strictEqual(r.trimmedTail, 'tree/main')
})

test('⭐ /blob/<branch>/<file> ⇒ 也能剥（源码链接很常见）', () => {
  const r = parseRepoUrl('https://github.com/acme/speech-kit/blob/main/README.md')
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.repo, 'speech-kit')
  assert.ok(r.trimmedTail.includes('blob'), r.trimmedTail)
})

test('⭐ 常见 GitHub 尾段都能剥（pulls / releases / issues …）', () => {
  // ⚠ 这些尾段**整个就是一个词**，后面没有 '/' ⇒
  //   ⛔ 正则里要求尾部带 '/' 会把它们全拒掉（2026-10-04 实测踩过）
  for (const tail of ['pulls', 'issues', 'releases/v1.2', 'wiki', 'actions']) {
    const r = parseRepoUrl(`https://github.com/a/b/${tail}`)
    assert.strictEqual(r.ok, true, `${tail} 被拒了：${r.error}`)
    assert.strictEqual(r.repo, 'b', tail)
  }
})

test('⛔ ⭐ 认不出来的尾段 ⇒ 拒，⛔ 不静默吞掉（可能拼错了）', () => {
  const r = parseRepoUrl('https://github.com/acme/speech-kit/pytorch/typo')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'UNKNOWN_TAIL')
  // ⭐ 2026-10-05：断言 **code + params**，⛔ 不再断言中文句子。
  //   界面文案归前端 t(en,zh) 管（editor/StepPrepare.jsx 的 ERR_TEXT），
  //   后端改措辞不该让测试红；反过来界面文案错了这里也测不到 —— 那在 UI 验。
  assert.strictEqual(r.params.tail, 'pytorch', '要把那段原文回给界面')
})


test('⛔ 查询串和锚点不算仓库名的一部分', () => {
  const a = parseRepoUrl('https://github.com/a/b?tab=readme-ov-file#top')
  const b = parseRepoUrl('https://github.com/a/b#readme')
  assert.strictEqual(a.repo, 'b')
  assert.strictEqual(b.repo, 'b')
})

test('⛔ 非 GitHub 主机不猜（平台不替用户决定别的主机怎么拉）', () => {
  for (const s of [
    'https://gitlab.com/a/b',
    'https://gitee.com/a/b',
    'https://bitbucket.org/a/b',
  ]) {
    const r = parseRepoUrl(s)
    assert.strictEqual(r.ok, false, s)
    assert.strictEqual(r.code, 'NOT_GITHUB', s)
  }
})

test('⛔ 只有 owner 没有 repo / 空输入，要说清缺什么', () => {
  // ⭐ 2026-10-05：空**链接**的 code 从 EMPTY 改成 EMPTY_LINK。
  //   理由：validateId 也用 EMPTY（空目录名），两者要分开的文案 ——
  //   「还没填链接」vs「目录名不能为空」不是一句话，
  //   ⛔ 共用一个 code 就只能写一句含糊的。
  assert.strictEqual(parseRepoUrl('acme').code, 'NO_OWNER')
  assert.strictEqual(parseRepoUrl('').code, 'EMPTY_LINK')
  assert.strictEqual(parseRepoUrl(null).code, 'EMPTY_LINK')
  assert.strictEqual(parseRepoUrl('https://github.com/acme').code, 'NO_REPO')
})

// ---------------------------------------------------------------------------
// 猜 id —— ⛔ 只是建议
// ---------------------------------------------------------------------------
test('猜 id：去掉 .git 后缀，保留大小写（⛔ 不擅自改名）', () => {
  assert.strictEqual(suggestId('speech-kit'), 'speech-kit')
  assert.strictEqual(suggestId('speech-kit.git'), 'speech-kit')
  assert.strictEqual(suggestId('my-tts-2'), 'my-tts-2')
  assert.strictEqual(suggestId(''), null)
  assert.strictEqual(suggestId(null), null)
})

test('⛔ 非法字符换成连字符（而不是报错 —— 仓库名确实可能带）', () => {
  assert.strictEqual(suggestId('a:b'), 'a-b')
  assert.strictEqual(suggestId('a b'), 'a b', '空格不是非法字符，只是目录名不好看')
})

test('⛔ 用户填的 id 优先于猜的，并标记「已确认」', () => {
  const a = resolveEngine({ url: 'a/repo-name' })
  assert.strictEqual(a.id, 'repo-name')
  assert.strictEqual(a.idConfirmed, false, '没填过不该算已确认')

  const b = resolveEngine({ url: 'a/repo-name', id: 'mychoice' })
  assert.strictEqual(b.id, 'mychoice')
  assert.strictEqual(b.idConfirmed, true, '用户自己填了 ⇒ 该提示不必再提')
})

// ---------------------------------------------------------------------------
// ⭐ 校验：判据 = registry.js 的真实规则
// ---------------------------------------------------------------------------
// ⚠ 2026-10-05 改了断言：原来要求 error 里带 "83"（registry.js 的行号）。
//   ⛔ 那条**测试本身在强制一个错误做法** —— 把内部文件行号讲给用户听。
//   Owner 原话：「前端的用词不能太随便」：用户要知道的是「换个名字」，
//   不是「registry.js 第 83 行会跳过它」。
test('⛔ `_` 开头必须被拒（平台会把这种目录当模板跳过，目录白建）', () => {
  const r = validateId('_TEMPLATE')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'RESERVED_PREFIX')
  assert.ok(r.params && r.params.prefix,
    '⛔ 必须把那个前缀回给界面，否则前端写不出「不能以 _ 开头」')
  assert.ok(!/\d{2,}/.test(r.error),
    `⛔ error 里不该出现内部行号（给用户看的）：${r.error}`)
})

test('⛔ `.` 开头同样被拒', () => {
  assert.strictEqual(validateId('.hidden').code, 'RESERVED_PREFIX')
  assert.strictEqual(validateId('.git').code, 'RESERVED_PREFIX')
})

test('⛔ Windows 非法字符被拒', () => {
  for (const s of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    const r = validateId(s)
    assert.strictEqual(r.ok, false, `${s} 竟通过了`)
    assert.strictEqual(r.code, 'ILLEGAL_CHAR', s)
  }
})

test('⛔ 平台的目录名不能拿来当引擎 id（会覆盖别人的东西）', () => {
  for (const s of ['engines', 'models', 'lib', 'web', 'tools', 'docs']) {
    assert.strictEqual(validateId(s).code, 'RESERVED_NAME', s)
  }
})

test('⛔ 前后空格被拒（id 与目录名必须逐字相同）', () => {
  assert.strictEqual(validateId(' x').code, 'WHITESPACE')
  assert.strictEqual(validateId('x ').code, 'WHITESPACE')
})

test('正常 id 通过', () => {
  for (const s of ['x', 'my-tts2', 'a.b_c', 'TTS', '引擎2', 'v2pro']) {
    assert.strictEqual(validateId(s).ok, true, s)
  }
})

test('⛔ 非法 id 要带着「建议值」回来，好让界面直接显示', () => {
  const r = resolveEngine({ url: 'a/repo', id: 'bad/id' })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'ILLEGAL_CHAR')
  assert.strictEqual(r.idSuggested, 'repo', '⛔ 得告诉用户「改成这个就能用」')
})

// ---------------------------------------------------------------------------
// cloneUrl
// ---------------------------------------------------------------------------
test('⛔ ⭐ cloneUrl 带 .git ⇒ repo 名必须剥掉后缀', () => {
  // ⚠ 这条是实测踩出来的（2026-10-04）：
  //   cloneUrl 一定带 .git（git clone 需要），但探测要读
  //   <repo>/main/pyproject.toml —— 用带后缀的名字会全 404，
  //   界面上表现为「没找到任何依赖清单」，而端点直接调却是好的。
  for (const u of [
    'https://github.com/a/b.git',
    'a/b.git',
  ]) {
    const r = parseRepoUrl(u)
    assert.strictEqual(r.ok, true, `${u}: ${r.error}`)
    assert.strictEqual(r.repo, 'b', `${u} → repo=${r.repo}（不该带 .git）`)
  }
})

test('⛔ 只有 .git 后缀、没有名字 ⇒ 拒', () => {
  const r = parseRepoUrl('https://github.com/a/.git')
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_REPO')
})

test('cloneUrl 带 .git（git clone 需要这个后缀）', () => {
  const r = resolveEngine({ url: 'https://github.com/a/b' })
  assert.strictEqual(r.cloneUrl, 'https://github.com/a/b.git')
  // ⭐ 而探测用的 repo 名不带后缀 —— 两者不是一回事
  assert.strictEqual(r.repo, 'b')
})

// ---------------------------------------------------------------------------
// 纪律
// ---------------------------------------------------------------------------
test('⛔ resolve.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm', 'chat' + 'tts']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'resolve.js'), 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of FORBIDDEN) {
    assert.ok(!code.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('⛔ 纪律：本文件不许出现具体引擎名（连测试里都不该有）', () => {
  const src = fs.readFileSync(__filename, 'utf-8')
  const code = src.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  for (const bad of ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice']) {
    assert.ok(!code.toLowerCase().includes(bad), `测试里出现了「${bad}」`)
  }
})
// ---------------------------------------------------------------------------
// ⭐ 2026-10-04 踩到的：resolveEngine **必须**返回 url（不带 .git）
//   第 2 步的探测读 <owner>/<repo>/main/pyproject.toml，
//   用带 .git 的名字会全 404 ⇒ 界面永远拿不到依赖列表。
// ---------------------------------------------------------------------------
test('⭐⭐ resolveEngine 返回 url（不带 .git），且与 cloneUrl 不同', () => {
  const r = resolveEngine({ url: 'https://github.com/a/b' })
  assert.strictEqual(r.url, 'https://github.com/a/b',
    '⛔ 没有 url —— 探测会全404（实测踩过）')
  assert.strictEqual(r.cloneUrl, 'https://github.com/a/b.git')
})

test('⭐ 归一化信息要一路传下去（界面上要告诉用户我们改了什么）', () => {
  const r = resolveEngine({ url: 'https://github.com/a/b/tree/dev_1.5' })
  assert.strictEqual(r.url, 'https://github.com/a/b')
  assert.strictEqual(r.trimmedTail, 'tree/dev_1.5')
  assert.ok(r.noteCode, '⛔ 没有归一化告知（code）')
})
