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

const { readScanConventions, detectModelVersion } = require('./engineScan')

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

//  读取与严格校验

test('readScanConventions: 没装这个引擎返回 null', () => {
  assert.equal(readScanConventions('no-such-engine'), null)
})

test('readScanConventions: 引擎没写 scan.json 返回 null（不推断）', () => {
  assert.equal(readScanConventions('fake-bare'), null)
})

test('readScanConventions: 假引擎的声明能读出来', () => {
  const conv = readScanConventions('fake-declared')
  assert.ok(conv)
  assert.equal(conv.language_from_name.length, 1)
  assert.equal(conv.steps_from_name.length, 1)
  assert.equal(conv.version.slot, 'weights')
  assert.equal(conv.version.header_map.AB, 'rev9')
  assert.deepEqual(conv.version.from_size, [
    { below_bytes: 1024, value: 'rev1' },
    { below_bytes: null, value: 'rev0' },
  ])
})

test('readScanConventions: 顶层不认识的键当场报错', () => {
  putEngine('bad-top', { nope: 1 })
  assert.throws(() => readScanConventions('bad-top'),
    (err) => err.code === 'ENGINE_SCAN_INVALID' && err.key === 'nope')
})

test('readScanConventions: 正则编译不过当场报错', () => {
  putEngine('bad-regex', { language_from_name: ['('] })
  assert.throws(() => readScanConventions('bad-regex'), /不是合法的正则/)
})

test('readScanConventions: 缺命名捕获组当场报错', () => {
  putEngine('bad-group', { language_from_name: ['_(\\w+)\\.ckpt$'] })
  assert.throws(() => readScanConventions('bad-group'), /命名捕获组/)
})

test('readScanConventions: from_size 最后一项必须兜底', () => {
  putEngine('bad-size', { version: { slot: 'w', from_size: [{ below_bytes: 10, value: 'x' }] } })
  assert.throws(() => readScanConventions('bad-size'), /最后一项要兜住所有尺寸/)
})

test('readScanConventions: version 没有任何判定规则当场报错', () => {
  putEngine('bad-empty-version', { version: { slot: 'w' } })
  assert.throws(() => readScanConventions('bad-empty-version'), /一条判定规则都没写/)
})

//  GSV 的声明复刻今天的命名与版本判定

test('gpt-sovits 的 scan.json 能读出来，语种与轮数正则照旧', () => {
  const gsv = readScanConventions('gpt-sovits')
  assert.ok(gsv)
  assert.equal(gsv.language_from_name[0].exec('role_ja-e10.ckpt').groups.lang, 'ja')
  assert.equal(gsv.language_from_name[1].exec('role_en_e5_s100.pth').groups.lang, 'en')
  assert.equal(gsv.steps_from_name[0].exec('role_ja-e10.ckpt').groups.step, '10')
})

test('gpt-sovits 的版本判定表与阈值照旧', () => {
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
