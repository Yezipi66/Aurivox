'use strict'

// ---------------------------------------------------------------------------
//  recipeStore — CRUD 与边界条件
// ---------------------------------------------------------------------------
// 用 tmpdir 隔离文件系统，mock paramTable 避免依赖 engines/ 目录。

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createRecipeStore, SCHEMA_VERSION, validateName, validateVoiceId } = require('./recipeStore')

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `recipeStore-${label}-`))
}

// ---------------------------------------------------------------------------
//  validateVoiceId / validateName — 纯函数
// ---------------------------------------------------------------------------

test('validateVoiceId: 接受合法 role', () => {
  assert.deepEqual(validateVoiceId('narrator'), { ok: true })
  assert.deepEqual(validateVoiceId('voice-01'), { ok: true })
  assert.deepEqual(validateVoiceId('A_b-c'), { ok: true })
})

test('validateVoiceId: 拒绝非法 role', () => {
  assert.equal(validateVoiceId('').ok, false)
  assert.equal(validateVoiceId('   ').ok, false)
  assert.equal(validateVoiceId(null).ok, false)
  assert.equal(validateVoiceId('a/b').ok, false)
  assert.equal(validateVoiceId('a b').ok, false)
  assert.equal(validateVoiceId('a.b').ok, false)
})

test('validateName: 接受合法 name', () => {
  assert.deepEqual(validateName('happy'), { ok: true, value: 'happy' })
  assert.deepEqual(validateName('  sad  '), { ok: true, value: 'sad' })
  assert.deepEqual(validateName('中文'), { ok: true, value: '中文' })
})

test('validateName: 拒绝非法 name', () => {
  assert.equal(validateName('').ok, false)
  assert.equal(validateName('   ').ok, false)
  assert.equal(validateName(null).ok, false)
  assert.equal(validateName('a/b').ok, false)
  assert.equal(validateName('a\\b').ok, false)
  assert.equal(validateName('a:b').ok, false)
  assert.equal(validateName('.').ok, false)
  assert.equal(validateName('..').ok, false)
  assert.equal(validateName('.hidden').ok, false)
  assert.equal(validateName('a'.repeat(65)).ok, false)
})

// ---------------------------------------------------------------------------
//  create — 创建配方
// ---------------------------------------------------------------------------

test('create: 成功创建配方并持久化', () => {
  const dir = tmpdir('create')
  const store = createRecipeStore(dir)
  const result = store.create({ role: 'narrator', name: 'happy', reference_text: '你好' })
  assert.equal(result.ok, true)
  assert.equal(result.recipe.id, 'narrator/happy')
  assert.equal(result.recipe.role, 'narrator')
  assert.equal(result.recipe.name, 'happy')
  assert.equal(result.recipe.schema_version, SCHEMA_VERSION)
  assert.equal(result.recipe.reference_text, '你好')
  // 文件已写入
  const filePath = path.join(dir, 'recipe_narrator_happy.json')
  assert.ok(fs.existsSync(filePath))
  const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  assert.equal(onDisk.id, 'narrator/happy')
})

test('create: 重复 ID 被拒绝', () => {
  const dir = tmpdir('dup')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy' })
  const result = store.create({ role: 'narrator', name: 'happy' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'exists')
})

test('create: force=true 覆盖已有配方', () => {
  const dir = tmpdir('force')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy', reference_text: '旧文本' })
  const result = store.create({ role: 'narrator', name: 'happy', reference_text: '新文本' }, { force: true })
  assert.equal(result.ok, true)
  assert.equal(result.recipe.reference_text, '新文本')
})

test('create: 非法 role 被拒绝', () => {
  const dir = tmpdir('badrole')
  const store = createRecipeStore(dir)
  const result = store.create({ role: 'a/b', name: 'happy' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

test('create: 非法 name 被拒绝', () => {
  const dir = tmpdir('badname')
  const store = createRecipeStore(dir)
  const result = store.create({ role: 'narrator', name: '.hidden' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

test('create: 绝对路径 reference_audio 被拒绝', () => {
  const dir = tmpdir('abspath')
  const store = createRecipeStore(dir)
  const result = store.create({ role: 'narrator', name: 'happy', reference_audio: '/etc/passwd' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

test('create: 含 .. 的 reference_audio 被拒绝', () => {
  const dir = tmpdir('dotdot')
  const store = createRecipeStore(dir)
  const result = store.create({ role: 'narrator', name: 'happy', reference_audio: '../secret.wav' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

// ---------------------------------------------------------------------------
//  get / list / resolveVoice
// ---------------------------------------------------------------------------

test('get: 读取已存在的配方', () => {
  const dir = tmpdir('get')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy', reference_text: '你好' })
  const recipe = store.get('narrator', 'happy')
  assert.ok(recipe)
  assert.equal(recipe.id, 'narrator/happy')
  assert.equal(recipe.reference_text, '你好')
})

test('get: 不存在的配方返回 null', () => {
  const dir = tmpdir('getnull')
  const store = createRecipeStore(dir)
  assert.equal(store.get('narrator', 'nonexistent'), null)
})

test('get: 非法 role/name 返回 null', () => {
  const dir = tmpdir('getinvalid')
  const store = createRecipeStore(dir)
  assert.equal(store.get('a/b', 'happy'), null)
  assert.equal(store.get('narrator', '.hidden'), null)
})

test('list: 返回所有配方', () => {
  const dir = tmpdir('list')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy' })
  store.create({ role: 'narrator', name: 'sad' })
  store.create({ role: 'hero', name: 'angry' })
  const all = store.list()
  assert.equal(all.length, 3)
})

test('list: 按 role 过滤', () => {
  const dir = tmpdir('listrole')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy' })
  store.create({ role: 'narrator', name: 'sad' })
  store.create({ role: 'hero', name: 'angry' })
  const filtered = store.list({ role: 'narrator' })
  assert.equal(filtered.length, 2)
  assert.ok(filtered.every(r => r.role === 'narrator'))
})

test('list: 空目录返回空数组', () => {
  const dir = tmpdir('listempty')
  const store = createRecipeStore(dir)
  assert.deepEqual(store.list(), [])
})

test('resolveVoice: 解析 role/name 格式', () => {
  const dir = tmpdir('resolve')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy' })
  const recipe = store.resolveVoice('narrator/happy')
  assert.ok(recipe)
  assert.equal(recipe.id, 'narrator/happy')
})

test('resolveVoice: 非法格式返回 null', () => {
  const dir = tmpdir('resolvebad')
  const store = createRecipeStore(dir)
  assert.equal(store.resolveVoice('noSlash'), null)
  assert.equal(store.resolveVoice('/name'), null)
  assert.equal(store.resolveVoice('role/'), null)
  assert.equal(store.resolveVoice(null), null)
})

// ---------------------------------------------------------------------------
//  update
// ---------------------------------------------------------------------------

test('update: 合并 patch 并持久化', () => {
  const dir = tmpdir('update')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy', reference_text: '旧文本' })
  const result = store.update('narrator', 'happy', { reference_text: '新文本' })
  assert.equal(result.ok, true)
  assert.equal(result.recipe.reference_text, '新文本')
  // role/name 不可变
  assert.equal(result.recipe.role, 'narrator')
  assert.equal(result.recipe.name, 'happy')
})

test('update: 不存在的配方返回 not_found', () => {
  const dir = tmpdir('updatenotfound')
  const store = createRecipeStore(dir)
  const result = store.update('narrator', 'nonexistent', { reference_text: 'x' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'not_found')
})

test('update: 非法 patch 被拒绝', () => {
  const dir = tmpdir('updateinvalid')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy' })
  const result = store.update('narrator', 'happy', { reference_audio: '/abs/path.wav' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

// ---------------------------------------------------------------------------
//  remove
// ---------------------------------------------------------------------------

test('remove: 删除存在的配方', () => {
  const dir = tmpdir('remove')
  const store = createRecipeStore(dir)
  store.create({ role: 'narrator', name: 'happy' })
  const ok = store.remove('narrator', 'happy')
  assert.equal(ok, true)
  assert.equal(store.get('narrator', 'happy'), null)
})

test('remove: 不存在的配方返回 false', () => {
  const dir = tmpdir('removenotfound')
  const store = createRecipeStore(dir)
  assert.equal(store.remove('narrator', 'nonexistent'), false)
})

test('remove: 非法 role/name 返回 false', () => {
  const dir = tmpdir('removeinvalid')
  const store = createRecipeStore(dir)
  assert.equal(store.remove('a/b', 'happy'), false)
  assert.equal(store.remove('narrator', '.hidden'), false)
})

// ---------------------------------------------------------------------------
//  engine_params — v4 格子
// ---------------------------------------------------------------------------

test('create: engine_params 原样存储', () => {
  const dir = tmpdir('engineparams')
  const store = createRecipeStore(dir)
  const result = store.create({
    role: 'narrator',
    name: 'happy',
    engine_params: { myengine: { custom_key: 'custom_value' } },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.recipe.engine_params, { myengine: { custom_key: 'custom_value' } })
})

test('create: engine_params 值非对象被拒绝', () => {
  const dir = tmpdir('engineparamsbad')
  const store = createRecipeStore(dir)
  const result = store.create({
    role: 'narrator',
    name: 'happy',
    engine_params: { myengine: 'not-an-object' },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

test('create: 未知 params 键落入 engine_params', () => {
  const dir = tmpdir('straykeys')
  const store = createRecipeStore(dir)
  const result = store.create({
    role: 'narrator',
    name: 'happy',
    params: { unknown_key: 'value', speed: 1.5 },
  })
  assert.equal(result.ok, true)
  // speed 是平台通用键，保留在 params
  assert.equal(result.recipe.params.speed, 1.5)
  // unknown_key 落入 engine_params._unassigned
  assert.equal(result.recipe.engine_params._unassigned.unknown_key, 'value')
})

// ---------------------------------------------------------------------------
//  schema_version 保留
// ---------------------------------------------------------------------------

test('create: 新配方使用当前 SCHEMA_VERSION', () => {
  const dir = tmpdir('schemaver')
  const store = createRecipeStore(dir)
  const result = store.create({ role: 'narrator', name: 'happy' })
  assert.equal(result.recipe.schema_version, SCHEMA_VERSION)
})

test('update: 保留原有 schema_version', () => {
  const dir = tmpdir('schemapreserve')
  const store = createRecipeStore(dir)
  // 手动写入一个旧版本配方
  const oldRecipe = {
    schema_version: 2,
    id: 'narrator/happy',
    role: 'narrator',
    name: 'happy',
    display_name: 'NARRATOR - happy',
    reference_audio: '',
    reference_text: '',
    language: '',
    engine_id: '',
    params: {},
    engine_params: {},
    gpt_ckpt: '',
    sovits_pth: '',
    emotion_ref: null,
    emo_vector: null,
    meta: { source: 'generate', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z', sovits_version: '', notes: '', tags: [] },
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'recipe_narrator_happy.json'), JSON.stringify(oldRecipe))
  const result = store.update('narrator', 'happy', { reference_text: '新文本' })
  assert.equal(result.ok, true)
  assert.equal(result.recipe.schema_version, 2)
})
