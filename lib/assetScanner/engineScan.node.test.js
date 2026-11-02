'use strict'

// scan.json 的解析与版本判定：假引擎走通用路径，GSV 的声明逐字复刻今天的扫描结果。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tmpEngines = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-scan-'))
process.env.AURIVOX_EXTRA_ENGINES_DIR = tmpEngines

function putEngine(id, scan, manifest = { id }) {
  const dir = path.join(tmpEngines, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  if (scan !== null) {
    fs.writeFileSync(path.join(dir, 'scan.json'),
      typeof scan === 'string' ? scan : JSON.stringify(scan))
  }
}

function putFile(dir, name, content) {
  const fp = path.join(dir, name)
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  fs.writeFileSync(fp, content)
  return fp
}

const { readScanConventions, readScanStatus, detectModelVersion } = require('./engineScan')

putEngine('fake-declared', {
  language_from_name: ['-(?<lang>[A-Z]{2})-take\\d+\\.bin$'],
  steps_from_name: ['take(?<step>\\d+)\\.bin$'],
  version: {
    slot: 'weights',
    header_map: { AB: 'rev9' },
    from_name: [{ pattern: '-beta', value: 'rev7' }],
    from_size: [{ below_bytes: 1024, value: 'rev1' }, { value: 'rev0' }],
  },
})
putEngine('fake-bare', null)
putEngine('fake-base', {
  base_models: [
    { slot: 'weights', name: 'base-a', candidates: ['v2/a.bin', 'v1/a.bin'], steps: null, default: true },
    { slot: 'weights', name: 'base-b', version: 'rev2', candidates: ['v2/b.bin'] },
  ],
})

//  读取与严格校验

test('readScanConventions: 引擎未安装时返回 null', () => {
  assert.equal(readScanConventions('no-such-engine'), null)
})

test('readScanConventions: 引擎未写 scan.json 时返回 null（平台不推断）', () => {
  assert.equal(readScanConventions('fake-bare'), null)
})

test('readScanConventions: 假引擎的声明能读出来', () => {
  const conv = readScanConventions('fake-declared')
  assert.ok(conv)
  assert.equal(conv.language_from_name.length, 1)
  assert.equal(conv.steps_from_name.length, 1)
  assert.equal(conv.version.slot, 'weights')
  assert.equal(conv.version.header_bytes, 2, '不写 header_bytes 时读 2 个字节')
  assert.equal(conv.version.header_map.AB, 'rev9')
  assert.deepEqual(conv.version.from_size, [
    { below_bytes: 1024, value: 'rev1' },
    { below_bytes: null, value: 'rev0' },
  ])
})

test('readScanConventions: 顶层不认识的键立即报错', () => {
  putEngine('bad-top', { nope: 1 })
  assert.throws(() => readScanConventions('bad-top'),
    (err) => err.code === 'ENGINE_SCAN_INVALID' && err.key === 'nope')
})

test('readScanConventions: 正则编译不过立即报错', () => {
  putEngine('bad-regex', { language_from_name: ['('] })
  assert.throws(() => readScanConventions('bad-regex'), /不是合法的正则/)
})

test('readScanConventions: 缺命名捕获组立即报错', () => {
  putEngine('bad-group', { language_from_name: ['_(\\w+)\\.ckpt$'] })
  assert.throws(() => readScanConventions('bad-group'), /命名捕获组/)
})

test('readScanConventions: from_size 最后一项必须兜底', () => {
  putEngine('bad-size', { version: { slot: 'w', from_size: [{ below_bytes: 10, value: 'x' }] } })
  assert.throws(() => readScanConventions('bad-size'), /最后一项必须覆盖所有尺寸/)
})

test('readScanConventions: version 没有任何判定规则立即报错', () => {
  putEngine('bad-empty-version', { version: { slot: 'w' } })
  assert.throws(() => readScanConventions('bad-empty-version'), /没有写任何判定规则/)
})

test('readScanConventions: 被转义的括号不算命名捕获组', () => {
  // 源码里有 "(?<lang>" 这几个字符，但那是一个被转义的字面括号：匹配出来的 m.groups 是 undefined。
  putEngine('bad-escaped-group', { language_from_name: ['x\\(?<lang>\\d+\\.bin$'] })
  assert.throws(() => readScanConventions('bad-escaped-group'), (err) =>
    /命名捕获组/.test(err.message) && /被转义/.test(err.message))
})

//  转义提示只给「写了这个组却没识别出来」的模式：未写 (?<lang> 的规则也收到这条，
//  读的人会去查一个不存在的转义。
test('⭐ 缺组的提示：未写 (?<lang> 时不给转义提示', () => {
  putEngine('bad-no-group-at-all', { language_from_name: ['_(\\w+)\\.ckpt$'] })
  assert.throws(() => readScanConventions('bad-no-group-at-all'),
    (err) => /命名捕获组/.test(err.message) && !/转义/.test(err.message))
})

test('readScanConventions: 语种与轮数也接受 { pattern, flags } 写法', () => {
  putEngine('fake-object-rules', {
    language_from_name: [{ pattern: '-(?<lang>[a-z]+)\\.bin$', flags: 'i' }],
    steps_from_name: [{ pattern: '_s(?<step>\\d+)\\.bin$' }],
  })
  const conv = readScanConventions('fake-object-rules')
  // flags 生效（大小写均匹配）；转小写由 scan.js 负责，不在正则里做。
  assert.equal(conv.language_from_name[0].exec('role-ZH.bin').groups.lang, 'ZH')
  assert.equal(conv.steps_from_name[0].exec('m_s42.bin').groups.step, '42')
})

test('readScanConventions: 带状态的 flags 立即报错（语种、轮数、版本三条规则同等对待）', () => {
  putEngine('bad-flag-g', { language_from_name: [{ pattern: '(?<lang>[a-z]+)', flags: 'g' }] })
  putEngine('bad-flag-y', { steps_from_name: [{ pattern: 's(?<step>\\d+)', flags: 'y' }] })
  putEngine('bad-flag-from-name', { version: { slot: 'w', from_name: [{ pattern: 'x', flags: 'g', value: 'v' }] } })
  for (const id of ['bad-flag-g', 'bad-flag-y']) {
    assert.throws(() => readScanConventions(id), /不能带 g 或 y/, id)
  }
  assert.throws(() => readScanConventions('bad-flag-from-name'), /不能带 g 或 y/)
})

test('readScanConventions: from_size 阈值不递增 ⇒ 无法命中的规则立即报错', () => {
  putEngine('bad-size-order', {
    version: { slot: 'w', from_size: [
      { below_bytes: 1000, value: 'big' },
      { below_bytes: 10, value: 'small' },
      { value: 'rest' },
    ] },
  })
  putEngine('bad-size-equal', {
    version: { slot: 'w', from_size: [
      { below_bytes: 100, value: 'a' },
      { below_bytes: 100, value: 'b' },
      { value: 'rest' },
    ] },
  })
  assert.throws(() => readScanConventions('bad-size-order'), /必须比前一项/)
  assert.throws(() => readScanConventions('bad-size-equal'), /必须比前一项/)
})

test('readScanConventions: header_map 的键长取决于 header_bytes', () => {
  putEngine('fake-head4', {
    version: { slot: 'w', header_bytes: 4, header_map: { ABCD: 'rev3' } },
  })
  putEngine('bad-head-len', { version: { slot: 'w', header_bytes: 4, header_map: { AB: 'rev3' } } })
  assert.equal(readScanConventions('fake-head4').version.header_map.ABCD, 'rev3')
  assert.throws(() => readScanConventions('bad-head-len'), /长度不是 4/)
})

test('readScanConventions: 版本头按字节读取，非字节的键无法命中', () => {
  putEngine('bad-head-char', { version: { slot: 'w', header_map: { 你好: 'rev1' } } })
  assert.throws(() => readScanConventions('bad-head-char'), /超出了字节范围/)
})

test('readScanConventions: 注释键只供阅读，只有版本头一层例外', () => {
  putEngine('fake-nested-comments', {
    _comment_top: '顶层注释',
    version: {
      _comment_version: '这一段的注释',
      slot: 'w',
      header_map: { AB: 'rev1' },
      from_name: [{ _comment: '单条规则的注释', pattern: '-x', value: 'rev0' }],
      from_size: [{ _comment: '兜底', below_bytes: 10, value: 'a' }, { value: 'b' }],
    },
  })
  const conv = readScanConventions('fake-nested-comments')
  assert.equal(conv.version.from_name.length, 1)
  assert.equal(conv.version.from_size.length, 2)
})

//  `_`（0x5F）本身是一个合法的版本头字节：这一层剥掉 `_` 前缀就等于静默吃掉一条真规则。
test('⭐ 版本头的键不剥 _ 前缀：以 _ 开头的头是规则，不是注释', () => {
  putEngine('fake-head-underscore', {
    version: { slot: 'w', header_bytes: 2, header_map: { _A: 'rev1', AB: 'rev2' } },
  })
  const conv = readScanConventions('fake-head-underscore')
  assert.deepEqual(Object.keys(conv.version.header_map), ['_A', 'AB'])
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'head-underscore-'))
  assert.equal(detectModelVersion(putFile(dir, 'w.bin', Buffer.from('_Azz')), conv.version), 'rev1',
    '两个字节真的读出来匹配，不是把这条键当注释丢掉')
})

test('readScanConventions: header_bytes 只支持 1..64', () => {
  putEngine('fake-head64', { version: { slot: 'w', header_bytes: 64, header_map: { ['x'.repeat(64)]: 'v64' } } })
  putEngine('bad-head0', { version: { slot: 'w', header_bytes: 0, header_map: { x: 'v' } } })
  putEngine('bad-head65', { version: { slot: 'w', header_bytes: 65, header_map: { x: 'v' } } })
  assert.equal(readScanConventions('fake-head64').version.header_map['x'.repeat(64)], 'v64', '上限本身要收得住')
  assert.throws(() => readScanConventions('bad-head0'), /1\.\.64/)
  assert.throws(() => readScanConventions('bad-head65'), /1\.\.64/)
})

test('readScanConventions: 不认识的键在每一层都点名，只有 _ 开头的例外', () => {
  putEngine('bad-nested-key', { version: { slot: 'w', header_maps: { AB: 'v' } } })
  assert.throws(() => readScanConventions('bad-nested-key'),
    (err) => err.code === 'ENGINE_SCAN_INVALID' && err.key === 'version.header_maps')
  // 「每一层」要逐层验：只验一层，其他层漏掉检查也仍然通过。
  // 键名带上下标，因为一份声明里通常有十几条规则，只说「有个键不认识」等于没说。
  const layers = [
    ['bad-layer-lang', { language_from_name: [{ pattern: 'x', flags: 'i', greedy: true }] },
      'language_from_name[0].greedy'],
    ['bad-layer-name', { version: { slot: 'w', from_name: [{ pattern: 'x', value: 'v', near: 1 }] } },
      'version.from_name[0].near'],
    ['bad-layer-size', { version: { slot: 'w', from_size: [{ below_bytes: 10, value: 'v', approx: true }] } },
      'version.from_size[0].approx'],
  ]
  for (const [id, scan, key] of layers) {
    putEngine(id, scan)
    assert.throws(() => readScanConventions(id),
      (err) => err.code === 'ENGINE_SCAN_INVALID' && err.key === key,
      `${key} 这一层没拦住：写错键名的人会收到一句通用报错，看不出是哪一个键`)
  }
})

//  缺在哪一层要能被问出来（界面与日志各自翻译，见 scan.js）

test('readScanStatus: 三种情况分别是约定、引擎未安装、未写 scan.json', () => {
  assert.deepEqual(
    { ...readScanStatus('no-such-engine'), file: null },
    { conventions: null, missing: 'engine_not_installed', file: null })
  const bare = readScanStatus('fake-bare')
  assert.equal(bare.conventions, null)
  assert.equal(bare.missing, 'no_scan_file')
  assert.match(bare.file, /fake-bare[/\\]scan\.json$/)
  const declared = readScanStatus('fake-declared')
  assert.ok(declared.conventions)
  assert.equal(declared.missing, null)
})

test('readScanStatus: 写了但无法读取的仍然抛，不降级成「没有该约定」', () => {
  putEngine('bad-top', { nope: 1 })
  assert.throws(() => readScanStatus('bad-top'), (err) => err.code === 'ENGINE_SCAN_INVALID')
})

//  大小兜底的边界：阈值是「小于」，不是「小于等于」

test('detectModelVersion: 正好等于阈值的文件走下一条规则', () => {
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'ver-boundary-'))
  putEngine('fake-boundary', {
    version: { slot: 'w', from_size: [{ below_bytes: 4, value: 'under' }, { value: 'over' }] },
  })
  const conv = readScanConventions('fake-boundary').version
  assert.equal(detectModelVersion(putFile(dir, 'three.bin', Buffer.alloc(3)), conv), 'under')
  assert.equal(detectModelVersion(putFile(dir, 'four.bin', Buffer.alloc(4)), conv), 'over')
})

test('detectModelVersion: header_bytes 声明几个字节就只读几个字节', () => {
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'ver-head4-'))
  const conv = readScanConventions('fake-head4').version
  assert.equal(detectModelVersion(putFile(dir, 'a.bin', Buffer.from('ABCDEF')), conv), 'rev3')
  assert.equal(detectModelVersion(putFile(dir, 'b.bin', Buffer.from('ABzzz')), conv), null)
})

//  底模候选声明

test('readScanConventions: base_models 原样读出候选与可选字段', () => {
  const conv = readScanConventions('fake-base')
  assert.deepStrictEqual(conv.base_models, [
    { slot: 'weights', name: 'base-a', candidates: ['v2/a.bin', 'v1/a.bin'], steps: null, default: true },
    { slot: 'weights', name: 'base-b', candidates: ['v2/b.bin'], version: 'rev2' },
  ])
})

test('readScanConventions: base_models 里不认识的键立即报错', () => {
  putEngine('bad-base-key', { base_models: [{ slot: 'w', name: 'x', candidates: ['a'], path: '/abs' }] })
  assert.throws(() => readScanConventions('bad-base-key'), /base_models\[0\]\.path/)
})

test('readScanConventions: base_models 的候选只能是相对路径', () => {
  putEngine('bad-base-abs', { base_models: [{ slot: 'w', name: 'x', candidates: ['/abs/a.bin'] }] })
  assert.throws(() => readScanConventions('bad-base-abs'), /只能写底模目录下的相对路径/)
  putEngine('bad-base-up', { base_models: [{ slot: 'w', name: 'x', candidates: ['../a.bin'] }] })
  assert.throws(() => readScanConventions('bad-base-up'), /只能写底模目录下的相对路径/)
})

test('readScanConventions: base_models 的条目缺 candidates 或类型不对立即报错', () => {
  putEngine('bad-base-empty', { base_models: [{ slot: 'w', name: 'x', candidates: [] }] })
  assert.throws(() => readScanConventions('bad-base-empty'), /candidates 必须是非空数组/)
  putEngine('bad-base-steps', { base_models: [{ slot: 'w', name: 'x', candidates: ['a'], steps: -1 }] })
  assert.throws(() => readScanConventions('bad-base-steps'), /steps 必须是非负整数或 null/)
  putEngine('bad-base-default', { base_models: [{ slot: 'w', name: 'x', candidates: ['a'], default: 'yes' }] })
  assert.throws(() => readScanConventions('bad-base-default'), /default 必须是布尔值/)
})

test('readScanConventions: base_models 写成空数组立即报错（不声明就把整段删掉）', () => {
  putEngine('bad-base-section-empty', { base_models: [] })
  assert.throws(() => readScanConventions('bad-base-section-empty'),
    (err) => err.code === 'ENGINE_SCAN_INVALID' && err.key === 'base_models')
})

test('readScanConventions: base_models 的条目也认 _ 开头的注释键', () => {
  putEngine('fake-base-comments', {
    base_models: [{ _comment: '这条是例子', slot: 'w', name: 'x', candidates: ['a.bin'] }],
  })
  assert.deepEqual(readScanConventions('fake-base-comments').base_models,
    [{ slot: 'w', name: 'x', candidates: ['a.bin'] }])
})

test('readScanConventions: 同一个位上两个默认项或两个同名条目立即报错', () => {
  // 前端用 find(x => x.default) 挑默认项，两条 default 时界面静默取第一项，
  // 用户以为选中的是另一个 ⇒ 这是会选错底模的错误，不是显示瑕疵。
  putEngine('bad-base-two-defaults', {
    base_models: [
      { slot: 'w', name: 'x', candidates: ['a.bin'], default: true },
      { slot: 'w', name: 'y', candidates: ['b.bin'], default: true },
    ],
  })
  assert.throws(() => readScanConventions('bad-base-two-defaults'), /default: true/)
  putEngine('bad-base-dup-name', {
    base_models: [
      { slot: 'w', name: '同名', candidates: ['a.bin'] },
      { slot: 'w', name: '同名', candidates: ['b.bin'] },
    ],
  })
  assert.throws(() => readScanConventions('bad-base-dup-name'), /两条都往 w\/同名 写/)
  // 另一个位上的同名条目不相干。
  putEngine('fake-base-same-name-other-slot', {
    base_models: [
      { slot: 'w', name: 'x', candidates: ['a.bin'] },
      { slot: 'enc', name: 'x', candidates: ['b.bin'] },
    ],
  })
  assert.equal(readScanConventions('fake-base-same-name-other-slot').base_models.length, 2)
})

//  GSV 的声明复刻今天的命名与版本判定

test('gpt-sovits 的 scan.json 能读出来，语种与轮数正则不变', () => {
  const gsv = readScanConventions('gpt-sovits')
  assert.ok(gsv)
  assert.equal(gsv.language_from_name[0].exec('role_ja-e10.ckpt').groups.lang, 'ja')
  assert.equal(gsv.language_from_name[1].exec('role_en_e5_s100.pth').groups.lang, 'en')
  assert.equal(gsv.steps_from_name[0].exec('role_ja-e10.ckpt').groups.step, '10')
})

test('gpt-sovits 的版本判定表与阈值不变', () => {
  const { version } = readScanConventions('gpt-sovits')
  assert.equal(version.slot, 'sovits')
  assert.deepEqual(version.header_map, {
    '00': 'v1', '01': 'v2', '02': 'v3', '03': 'v3',
    '04': 'v4', '05': 'v2Pro', '06': 'v2ProPlus',
  })
  assert.deepEqual(version.from_size, [
    { below_bytes: 84969472, value: 'v1' },
    { below_bytes: 734003200, value: 'v2' },
    { below_bytes: null, value: 'v3' },
  ])
})

test('detectModelVersion: 版本头优先', () => {
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'ver-head-'))
  const gsv = readScanConventions('gpt-sovits').version
  assert.equal(detectModelVersion(putFile(dir, 'a.pth', Buffer.from('0000')), gsv), 'v1')
  assert.equal(detectModelVersion(putFile(dir, 'b.pth', Buffer.from('0500')), gsv), 'v2Pro')
})

test('detectModelVersion: 版本头认不出时看文件名', () => {
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'ver-name-'))
  const gsv = readScanConventions('gpt-sovits').version
  assert.equal(detectModelVersion(putFile(dir, 'm_v2ProPlus_e10_s100.pth', Buffer.from('PK00')), gsv), 'v2ProPlus')
  assert.equal(detectModelVersion(putFile(dir, 'm_v2Pro_e10_s100.pth', Buffer.from('PK00')), gsv), 'v2Pro')
  assert.equal(detectModelVersion(putFile(dir, 'm_v2_e10_s100.pth', Buffer.from('PK00')), gsv), 'v2')
})

test('detectModelVersion: 文件名也没有时按大小兜底', () => {
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'ver-size-'))
  const gsv = readScanConventions('gpt-sovits').version
  assert.equal(detectModelVersion(putFile(dir, 'tiny.pth', Buffer.from('PK00')), gsv), 'v1')
})

test('detectModelVersion: 文件不存在返回 null', () => {
  const gsv = readScanConventions('gpt-sovits').version
  assert.equal(detectModelVersion('/nonexistent/file.pth', gsv), null)
})

test('detectModelVersion: 假引擎的版本头也按自己的声明映射', () => {
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'fake-ver-'))
  const conv = readScanConventions('fake-declared').version
  assert.equal(detectModelVersion(putFile(dir, 'x.bin', Buffer.from('AB00')), conv), 'rev9')
  assert.equal(detectModelVersion(putFile(dir, 'x-beta.bin', Buffer.from('ZZ00')), conv), 'rev7')
})

// 「文件名里那个版本 token 是什么意思」在 lib/training/version.js 还有第二处读法，
// 两处的分工写在 docs/ENGINE_ONBOARDING_CONTRACT.md 的『模型文件名的读法：引擎目录下的 scan.json』一节。
// 分成两处是现状，读出不一样是事故：
// 生成页拿扫出来的 version 去查底模齐不齐，训练拿 version.js 的决定加载哪一份，
// 只改一边的 token 名，两边各自都绿，界面上的底模提示却和实际加载的底模不是同一版。
test('⭐ 文件名版本 token：扫描侧与训练侧对每个文件名给出同一个答案', () => {
  const { versionFromName } = require('../training/version')
  const gsv = readScanConventions('gpt-sovits').version
  const dir = fs.mkdtempSync(path.join(tmpEngines, 'ver-pair-'))
  for (const name of [
    'gpt-sovits_v2ProPlus_e10_s100.pth', 'gpt-sovits_v2pro_e10_s100.pth',
    'GPT-SoVITS_V2PROPLUS_e3_s2.pth', 'gpt-sovits_v2_e10_s100.pth', 'GPT_SoVITS_V2_e10.pth',
  ]) {
    const fromTraining = versionFromName(name)
    assert.notEqual(fromTraining, '', `${name} 里根本没有版本 token，这条对照没意义`)
    assert.equal(detectModelVersion(putFile(dir, name, Buffer.from('PK00')), gsv), fromTraining,
      `${name}：扫盘读的是 engines/gpt-sovits/scan.json 的 version.from_name，` +
      '训练读的是 lib/training/version.js 的正则。两边要一起改，只改一边就让底模提示和实际加载错位')
  }
})
