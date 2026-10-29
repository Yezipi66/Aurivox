'use strict'
// 第 4 步的表单形状：必填 5 格两行（第 1 行另有一个可选的参考文本格），其余进「可选参数」，没有「高级」折叠区。
//
// 守的形状：
//   ① 必填区只有 5 格：三个输入槽位一行（text / ref_audio / output_path，参考音频旁边是可选的 ref_text），
//      引擎目录与启动脚本一行。平台其余的键缺了有默认（lib/engines/profile.js 的 DEFAULTS），
//      不许再摆进必填区让人猜。
//   ② 两行都用 auto-fit 网格，中栏被拖窄时折成单列，不写死列数。
//   ③ 「高级」折叠区与它的全量嵌套编辑器（NestedSections）不在了；
//      可选项在「可选参数」区里：合成参数 + 引擎配置，引擎配置默认一行不显示。
//
// 判据落在源码声明上（不渲染 JSX）。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const EDITOR = path.join(__dirname, '..', 'editor')
const src = fs.readFileSync(path.join(EDITOR, 'RequiredFields.jsx'), 'utf8')
const form = fs.readFileSync(path.join(EDITOR, 'ManifestForm.jsx'), 'utf8')
const optional = fs.readFileSync(path.join(EDITOR, 'OptionalConfig.jsx'), 'utf8')
const css = fs.readFileSync(path.join(EDITOR, 'editor.css'), 'utf8')

function stripComments (text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

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

function badgeCodes (text) {
  return [...text.matchAll(/code="([^"]+)"/g)].map((m) => m[1])
}

function slotCodes (text) {
  const m = /const SLOT_LABELS = \{([\s\S]*?)\n  \}/.exec(text)
  if (!m) return []
  return [...m[1].matchAll(/(\w+):\s*\{/g)].map((k) => k[1])
}

test('必填区恰好 5 格：三个槽位 + 引擎目录 + 启动脚本（参考文本是可选格，挨着参考音频）', () => {
  const live = stripComments(src)
  assert.deepStrictEqual(slotCodes(live), ['text', 'ref_audio', 'ref_text', 'output_path'])
  assert.ok(/ref_text: \{[^}]*optional: true/.test(live), '参考文本要标成可选格，不能和必填格一个待遇')
  assert.deepStrictEqual(badgeCodes(live).sort(), ['runtime.entry', 'runtime.python'])
})

test('平台有默认的键不许回到必填区', () => {
  const live = stripComments(src)
  for (const k of ['timeout_ms', 'max_chars', 'ready_timeout_ms', 'ready_endpoint',
    'requires_reference_audio', 'output_sample_rate', 'reference_clip_seconds']) {
    assert.ok(!live.includes(k), `必填区里又出现了「${k}」：它缺了平台有默认，不该让人填`)
  }
})

test('必填区两行，都用 auto-fit 网格', () => {
  const live = stripComments(src)
  const rows = live.match(/className="form-grid wz-required-row"/g) || []
  assert.strictEqual(rows.length, 2, `必填区应当是两行，现在 ${rows.length} 行`)
  const rule = /\.form-grid\.wz-required-row\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule, 'editor.css 里没有 .form-grid.wz-required-row')
  assert.ok(/repeat\(auto-fit,\s*minmax\(/.test(rule[1]), '必填行要用 auto-fit，中栏拖窄时才折得成单列')
})

test('每格是「中文人话 + 键名徽标」', () => {
  const live = stripComments(src)
  assert.ok(/badge badge-accent/.test(live))
  const cells = [...live.matchAll(/<Cell label=\{t\('[^']+', '([^']+)'\)\} code="([^"]+)"/g)]
  assert.strictEqual(cells.length, 2, '引擎目录与启动脚本两格要是「人话 + 徽标」')
  for (const [, zh, code] of cells) assert.notStrictEqual(zh, code)
})

test('「高级」折叠区与全量嵌套编辑器不在了', () => {
  const live = stripComments(form)
  assert.ok(!/expert-block|Advanced|高级/.test(live), 'ManifestForm 里还留着「高级」')
  assert.ok(!fs.existsSync(path.join(EDITOR, 'NestedSections.jsx')), 'NestedSections.jsx 应当删掉，不留空壳')
  assert.ok(/<OptionalConfig\b/.test(live), '引擎配置没有挂进可选参数区')
})

test('引擎配置的清单覆盖平台有默认的那几项，且每项写明不填时平台怎么办', () => {
  const { OPTIONAL_KEYS } = loadOptionalKeys()
  const paths = OPTIONAL_KEYS.map((k) => k.path)
  for (const k of ['timeout_ms', 'max_chars', 'runtime.ready_timeout_ms', 'runtime.ready_endpoint',
    'capabilities.requires_reference_audio',
    'capabilities.reference_clip_seconds']) {
    assert.ok(paths.includes(k), `引擎配置里少了「${k}」：缺了它就没地方改`)
  }
  assert.ok(!paths.includes('capabilities.output_sample_rate'),
    '输出采样率只是声明、平台不读，不该摆进引擎配置；引擎能调采样率就拖进合成参数')
  for (const k of OPTIONAL_KEYS) assert.ok(k.fallbackZh && k.fallbackEn, `「${k.path}」没写不填时平台怎么办`)
  assert.ok(/rowVisible\(/.test(optional), '引擎配置要按「写了才显示」过滤，不能一上来全摆出来')
})

test('引擎配置的增删：加一项带上出处，删一项连出处一起删，删空的段不留', () => {
  const { OPTIONAL_KEYS, addItem, removeItem, rowVisible } = loadOptionalKeys()
  const item = OPTIONAL_KEYS.find((k) => k.path === 'runtime.ready_timeout_ms')
  const base = { id: 'x', runtime: { python: 'p', entry: '../../lib/engines/host.py' } }
  assert.ok(!rowVisible(base, item), '没写的项默认不显示')
  const added = addItem(base, item)
  assert.strictEqual(added.runtime.ready_timeout_ms, 240000)
  assert.strictEqual(added.runtime.ready_timeout_ms_source, 'estimated', '写了数就得写出处')
  assert.ok(rowVisible(added, item))
  const removed = removeItem(added, item)
  assert.deepStrictEqual(removed, base, '删掉后应当回到原样（出处也删）')
  const clip = OPTIONAL_KEYS.find((k) => k.path === 'capabilities.reference_clip_seconds')
  assert.deepStrictEqual(removeItem(addItem(base, clip), clip), base, '删空的 capabilities 段不该留成 {}')
  const ep = OPTIONAL_KEYS.find((k) => k.path === 'runtime.ready_endpoint')
  assert.ok(rowVisible({ runtime: { entry: 'serve.py' } }, ep), '自带服务脚本时就绪端点平台答不出，要显示')
})

test('加时长区间时起始值是不限制，不许写死某台引擎的范围', () => {
  const { OPTIONAL_KEYS, addItem } = loadOptionalKeys()
  const clip = OPTIONAL_KEYS.find((k) => k.path === 'capabilities.reference_clip_seconds')
  const added = addItem({ id: 'x' }, clip)
  assert.strictEqual(added.capabilities.reference_clip_seconds, null,
    '加一项就写一个时长范围，等于替这台引擎凭空造了一条约束；缺着时平台不检查，填了才拦')
})

test('引擎配置：平台默认答了、表单里也没写的项挂「平台默认」，读的是 profile.defaulted', () => {
  const { platformDefaultedRows } = loadOptionalKeys()
  const defaulted = ['timeout_ms', 'max_chars', 'runtime.ready_timeout_ms', 'runtime.ready_endpoint']
  const rows = platformDefaultedRows({ id: 'x', max_chars: 40, max_chars_source: 'measured' }, defaulted)
  assert.deepStrictEqual(rows.map((r) => r.path),
    ['timeout_ms', 'runtime.ready_timeout_ms', 'runtime.ready_endpoint'],
    '表单里写了的 max_chars 不能再算平台默认')
  assert.deepStrictEqual(platformDefaultedRows({}, null), [], '读不到 profile 就不标')
  assert.ok(/platformDefaultedRows\(/.test(optional) && /\/wizard\/profile\//.test(optional),
    'OptionalConfig 要读平台的 profile.defaulted，不在界面里自己推')
  assert.ok(optional.includes("'平台默认'"), '徽标文案是「平台默认」')
})

test('引擎配置：本机测得的项另列「本机测得」，不混进「平台默认」', () => {
  const { platformDefaultedRows, localMeasuredRows } = loadOptionalKeys()
  // 平台解析的结果：timeout_ms 本机测过，ready 名片没写也没测过，max_chars 名片写了。
  const sources = { timeout_ms: 'local', 'runtime.ready_timeout_ms': 'default', max_chars: 'manifest' }
  const defaulted = ['runtime.ready_timeout_ms']
  assert.deepStrictEqual(localMeasuredRows(sources).map((r) => r.path), ['timeout_ms'])
  assert.deepStrictEqual(platformDefaultedRows({ id: 'x' }, defaulted).map((r) => r.path), ['runtime.ready_timeout_ms'],
    '本机测得的 timeout_ms 不能再挂「平台默认」')
  assert.deepStrictEqual(localMeasuredRows(null), [])
  assert.ok(/localMeasuredRows\(/.test(optional) && optional.includes('value_sources'),
    'OptionalConfig 要读平台的 profile.value_sources')
})

test('第 5 步进度文案：阶段四种，已用时间 mm:ss', () => {
  const esbuild = require('../../../lib/testDeps.js').esbuild()
  const code = esbuild.transformSync(fs.readFileSync(path.join(EDITOR, 'measureProgress.js'), 'utf8'),
    { loader: 'js', format: 'cjs', target: 'node18' }).code
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', code)(mod.exports, () => { throw new Error('不该有依赖') }, mod)
  const P = mod.exports
  const t = (en, zh) => zh
  assert.deepStrictEqual(['starting', 'synth', 'done', 'failed'].map((s) => P.measureStageLabel(s, t)),
    ['启动中', '合成中', '完成', '失败'])
  assert.equal(P.formatElapsed(65000), '01:05')
  assert.equal(P.formatElapsed(3725000), '1:02:05')
  assert.equal(P.measureRunning({ state: 'running' }), true)
  assert.equal(P.measureRunning({ state: 'done' }), false)
  assert.equal(P.measureRunning(null), false)
})

test('参考文本格：可拖、可清，空着只给提示，不挂「需指定」', () => {
  const live = stripComments(src)
  assert.ok(/onDrop=\{dropOn\(slot\.key\)\}/.test(live), '槽位格（含参考文本）要能拖进参数')
  assert.ok(/onClick=\{\(\) => setSlot\(slot\.key, ''\)\}/.test(live), '可选格要有清除按钮，清掉就是从 bind 里删')
  assert.ok(/&& !slot\.optional/.test(live), '可选格空着不该算「未匹配，需指定」')
  assert.ok(live.includes('平台只能尽量匹配，不一定认得出'), '空着时给一句提示')
})

test('参考文本没绑不是校验错误', () => {
  const { diagnose } = require('../core/validate.js')
  const m = {
    contract_version: 2, id: 'x', label: 'x',
    runtime: { python: 'engines/x/.venv', entry: '../../lib/engines/host.py' },
    call: { kind: 'cli', argv: ['{engine_python}', '-m', 'm'], bind: { text: '--text', ref_audio: '--ref', output_path: '--out' }, seed: 'none' },
  }
  const all = diagnose(m)
  assert.ok(!all.some((d) => /ref_text/.test(String(d.field || '') + String(d.message || ''))),
    '没绑参考文本不该出现在诊断里：' + JSON.stringify(all))
})
