'use strict'
// 落盘 —— 用**临时目录**测，绝不碰真实的 engines/
//
// ⭐ 为什么全部用临时目录
//   这份代码会 mkdir + writeFile + rename。真 engines/ 里有用户在用的引擎，
//   测试碰一下就是事故。
//   ⇒ opts.enginesDir 存在的意义就在这里。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { saveManifest, validateId, listInstalled, readManifestById } = require('../core/save.js')

function tmpEngines () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-wizard-save-'))
}

function readBack (dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf-8'))
}

// ---------------------------------------------------------------------------
// id 合法性 —— 这是最常错的一项，且错了平台会报 ID_MISMATCH
// ---------------------------------------------------------------------------
test('id 校验：空 / 带路径 / 保留名 / 前导空格 都要拦下', () => {
  assert.ok(validateId('') === 'id is required')
  assert.ok(validateId('   ') === 'id is required')
  assert.ok(validateId(' a'), '前导空格应被拒')
  assert.ok(validateId('a/b'), '含斜杠应被拒')
  assert.ok(validateId('a\\b'), '含反斜杠应被拒')
  assert.ok(validateId('a:b'), '含冒号应被拒')
  assert.ok(validateId('_TEMPLATE'), '平台保留名应被拒')
  assert.ok(validateId('.hidden'), '前导点应被拒')
  assert.strictEqual(validateId('wobble'), null, '正常 id 应通过')
  assert.strictEqual(validateId('some-tts2'), null)
})

// ---------------------------------------------------------------------------
// 基本落盘
// ---------------------------------------------------------------------------
test('存一张名片：目录 + 文件都建出来，内容对得上', () => {
  const dir = tmpEngines()
  const m = { id: 'wobble', label: 'Wobble', runtime: { python: 'engines/wobble/.venv' } }
  const r = saveManifest(m, { enginesDir: dir })
  assert.strictEqual(r.ok, true, JSON.stringify(r))
  assert.ok(fs.existsSync(path.join(dir, 'wobble', 'manifest.json')))
  const back = readBack(dir, 'wobble')
  assert.strictEqual(back.label, 'Wobble')
  assert.strictEqual(back.runtime.python, 'engines/wobble/.venv')
})

test('文件末尾有换行（git 里更友好）', () => {
  const dir = tmpEngines()
  saveManifest({ id: 'wobble', label: 'W' }, { enginesDir: dir })
  const raw = fs.readFileSync(path.join(dir, 'wobble', 'manifest.json'), 'utf-8')
  assert.ok(raw.endsWith('}\n'), '应以 } + 换行 结尾')
})

// ---------------------------------------------------------------------------
// ⛔ 不覆盖
// ---------------------------------------------------------------------------
test('⛔ 文件已存在时不静默覆盖', () => {
  const dir = tmpEngines()
  saveManifest({ id: 'wobble', label: 'first' }, { enginesDir: dir })
  const r = saveManifest({ id: 'wobble', label: 'second' }, { enginesDir: dir })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'EXISTS')
  assert.strictEqual(readBack(dir, 'wobble').label, 'first', '原内容不该被动')
})

test('显式 overwrite 才覆盖', () => {
  const dir = tmpEngines()
  saveManifest({ id: 'wobble', label: 'first' }, { enginesDir: dir })
  const r = saveManifest({ id: 'wobble', label: 'second' },
    { enginesDir: dir, overwrite: true })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.replaced, true)
  assert.strictEqual(readBack(dir, 'wobble').label, 'second')
})

test('allowCreateDir:false 时不建目录，如实报 NO_DIR', () => {
  const dir = tmpEngines()
  const r = saveManifest({ id: 'wobble', label: 'W' },
    { enginesDir: dir, allowCreateDir: false })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_DIR')
  assert.ok(!fs.existsSync(path.join(dir, 'wobble')), '不该建目录')
})

// ---------------------------------------------------------------------------
// 形状不对
// ---------------------------------------------------------------------------
test('不是对象的输入直接拒', () => {
  const dir = tmpEngines()
  for (const bad of [null, 'x', 42, [1, 2]]) {
    const r = saveManifest(bad, { enginesDir: dir })
    assert.strictEqual(r.ok, false, String(bad))
    assert.strictEqual(r.code, 'BAD_SHAPE')
  }
})

test('id 不合法 ⇒ BAD_ID，且不建任何目录', () => {
  const dir = tmpEngines()
  const r = saveManifest({ id: '../escape', label: 'X' }, { enginesDir: dir })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'BAD_ID')
  assert.strictEqual(fs.readdirSync(dir).length, 0, '临时目录应仍是空的')
})

// ---------------------------------------------------------------------------
// ⛔ 写出去的 JSON 必须永远可解析（不许留半个文件）
// ---------------------------------------------------------------------------
test('⛔ 循环引用不产生半个文件', () => {
  const dir = tmpEngines()
  const m = { id: 'wobble', label: 'W' }
  m.self = m                       // ⛔ JSON.stringify 会抛
  const r = saveManifest(m, { enginesDir: dir })
  assert.strictEqual(r.ok, false, '不可序列化的输入不该报成功')
  // 目录建了但不该留半个 JSON
  const p = path.join(dir, 'wobble', 'manifest.json')
  assert.ok(!fs.existsSync(p), '不该留下半个 manifest.json')
  // ⛔ 临时文件也要清掉
  assert.ok(!fs.existsSync(p + '.tmp-wizard'), '临时文件没清掉')
})

test('dryRun：只报不写', () => {
  const dir = tmpEngines()
  const r = saveManifest({ id: 'wobble', label: 'W' }, { enginesDir: dir, dryRun: true })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.dryRun, true)
  assert.ok(r.bytes > 0)
  assert.ok(!fs.existsSync(path.join(dir, 'wobble')), 'dryRun 不该建目录')
})

// ---------------------------------------------------------------------------
// 已装清单
// ---------------------------------------------------------------------------
test('已装清单：只列有 manifest 的目录，且能看出 id 是否与目录名一致', () => {
  const dir = tmpEngines()
  fs.mkdirSync(path.join(dir, 'a'))
  fs.writeFileSync(path.join(dir, 'a', 'manifest.json'), '{"id":"a","label":"A"}')
  fs.mkdirSync(path.join(dir, 'b'))
  fs.writeFileSync(path.join(dir, 'b', 'manifest.json'), '{"id":"WRONG","label":"B"}')
  fs.mkdirSync(path.join(dir, 'c'))            // 只有目录没有 manifest
  fs.mkdirSync(path.join(dir, '_TEMPLATE'))    // 平台保留

  const list = listInstalled({ enginesDir: dir })
  const ids = list.map((e) => e.id).sort()
  assert.deepStrictEqual(ids, ['a', 'b'], '_TEMPLATE 与没有 manifest 的目录不该出现')
  assert.strictEqual(list.find((e) => e.id === 'a').idMatchesDir, true)
  assert.strictEqual(list.find((e) => e.id === 'b').idMatchesDir, false,
    'id 与目录名不符要能看出来（平台会报 ID_MISMATCH）')
})

// ---------------------------------------------------------------------------
// 读名片 —— 上一轮验收时发现「读不了已装名片」，这里补上
// ---------------------------------------------------------------------------
test('读一张已装名片：内容原样回来', () => {
  const dir = tmpEngines()
  const m = { id: 'wobble', label: 'Wobble', runtime: { python: 'engines/wobble/.venv' } }
  saveManifest(m, { enginesDir: dir })
  const r = readManifestById('wobble', { enginesDir: dir })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.manifest.label, 'Wobble')
  assert.strictEqual(r.manifest.runtime.python, 'engines/wobble/.venv')
})

test('⛔ 读盘也要防路径穿越（写入拦了，读也必须拦）', () => {
  const dir = tmpEngines()
  // 在 engines/ 外面放一个 manifest.json，试着用 ../ 读出来
  const outside = path.join(dir, '..', 'outside-secret.json')
  fs.writeFileSync(outside, '{"id":"outside-secret","label":"should not be reachable"}')
  try {
    for (const bad of ['../outside-secret', '..', 'a/b', 'a\\b', '_TEMPLATE', '']) {
      const r = readManifestById(bad, { enginesDir: dir })
      assert.strictEqual(r.ok, false, `"${bad}" 竟被读出来了`)
      assert.ok(['BAD_ID', 'OUT_OF_SCOPE', 'NO_MANIFEST'].includes(r.code), r.code)
    }
  } finally {
    fs.unlinkSync(outside)
  }
})

test('⛔ 坏掉的 JSON 如实报 BAD_JSON，不能返回空对象', () => {
  const dir = tmpEngines()
  fs.mkdirSync(path.join(dir, 'broken'))
  fs.writeFileSync(path.join(dir, 'broken', 'manifest.json'), '{ "id": "broken", ')
  const r = readManifestById('broken', { enginesDir: dir })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'BAD_JSON')
  assert.ok(r.error.includes('not valid JSON'), r.error)
})

test('⛔ ⭐ 注释键必须逐字保留（写盘时剥 = 读一次就永久删掉文档）', () => {
  const dir = tmpEngines()
  const m = {
    id: 'wobble',
    label: 'Wobble',
    _comment_note: 'a note that must survive the round trip',
    _needs_review: true,
    parameters: [{ name: 'cfg', type: 'string', label: { en: 'C', zh: 'C中' } }],
    runtime: { args: ['--flag', '{checkpoints}'], ready_timeout_ms: 90000 },
  }
  saveManifest(m, { enginesDir: dir })
  // 磁盘上就该有 —— 上游作者靠这些键写安装说明
  const raw = fs.readFileSync(path.join(dir, 'wobble', 'manifest.json'), 'utf-8')
  assert.ok(raw.includes('_comment_note'), '注释键没写进磁盘')
  const back = readManifestById('wobble', { enginesDir: dir }).manifest
  assert.strictEqual(back._comment_note, m._comment_note)
  assert.strictEqual(back._needs_review, true)
  assert.strictEqual(back.parameters[0].label.zh, 'C中',
    '本地化 label 往返丢了字段')
  assert.deepStrictEqual(back.runtime.args, m.runtime.args)
})

// ---------------------------------------------------------------------------
// 纪律：本文件不许出现任何具体引擎名
// ---------------------------------------------------------------------------
test('⛔ save.js / savebridge.js 活代码里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice']
  const path2 = require('node:path')
  for (const f of ['save.js', 'savebridge.js']) {
    const src = fs.readFileSync(path2.join(__dirname, '..', 'core', f), 'utf-8')
    const code = src.split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    for (const bad of FORBIDDEN) {
      assert.ok(!code.toLowerCase().includes(bad),
        `${f} 活代码里出现了「${bad}」`)
    }
  }
})