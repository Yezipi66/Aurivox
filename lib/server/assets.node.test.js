'use strict'
// lib/server/assets.js：资产目录要真的读得到。
// 资产根取错名字（lib/paths 只导出 ASSETS_ROOT）时拿到的是 undefined：
//   assetsNeedScan 恒为 false（启动时从不自动扫描），collectTakenVoiceIds 漏掉全部资产目录，而且都不报错。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-assets-'))
process.env.ASSETS_ROOT = ROOT

// 下拉为什么是空的，得有人替用户记住：registry 在模块加载时读附加引擎目录，
// 所以假引擎要排在 require('./assets') 之前造好。位名与显示名和仓库里任何真引擎都无关。
const tmpEngines = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-assets-engines-'))
const ckRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-assets-ckpt-'))
process.env.AURIVOX_EXTRA_ENGINES_DIR = tmpEngines
process.env.AURIVOX_ASSETS_CK = ckRoot
const fakeManifest = (id) => ({
  id, label: `Fake ${id}`,
  weights: ['acoustic'],
  models: { checkpoints_env: 'AURIVOX_ASSETS_CK', required: [] },
  runtime: { python: `engines/${id}/.venv`, entry: 'infer_server.py', cwd: '.', ready_endpoint: '/health' },
  capabilities: { requires_reference_audio: true, streaming: true, output_sample_rate: 24000, supports_finetune: false },
})
for (const [id, scan] of [
  ['silent-base', { base_models: [{ slot: 'acoustic', name: 'Starter', candidate: ['a.bin'] }] }],
  ['talking-base', { base_models: [{ slot: 'acoustic', name: 'Starter', candidates: ['a.bin'] }] }],
]) {
  fs.mkdirSync(path.join(tmpEngines, id), { recursive: true })
  fs.writeFileSync(path.join(tmpEngines, id, 'manifest.json'), JSON.stringify(fakeManifest(id)))
  fs.writeFileSync(path.join(tmpEngines, id, 'scan.json'), JSON.stringify(scan))
}

const { assetsNeedScan, collectTakenVoiceIds, baseVoiceMeta } = require('./assets')

test('有资产目录缺 meta.json / segments.json ⇒ assetsNeedScan 为真（启动时会自动扫描）', () => {
  fs.mkdirSync(path.join(ROOT, 'demo_voice', 'raw'), { recursive: true })
  assert.equal(assetsNeedScan(), true)
})

test('collectTakenVoiceIds 认得资产目录里的音色', () => {
  const r = collectTakenVoiceIds({ loadVoices: () => ({}), assetId: null, trainingPipeline: null })
  const ids = r instanceof Set ? [...r] : (r.taken ? [...r.taken] : Object.keys(r))
  assert.ok(ids.includes('demo_voice'), `没认出资产目录：${JSON.stringify(ids)}`)
})

// 底模体检读的是 lib/paths 那条链（GSV_PRETRAINED_DIR → TTS_MODELS_DIR → MODELS_DIR），
// 不是名片的 runtime.checkpoints：两个根目录暂时不是一个来源，并成一个属于训练通用化那一刀。
// paths.js 在模块加载时读环境变量，所以每换一套 env 都要重开一个进程；底模根也让它自己算，
// 这份测试不再抄一遍布局。
const { execFileSync } = require('node:child_process')

function checkIn(modelsDir, version) {
  const script =
    `const P = require(${JSON.stringify(path.join(__dirname, '..', 'paths.js'))});` +
    `const A = require(${JSON.stringify(path.join(__dirname, 'assets.js'))});` +
    `process.stdout.write(JSON.stringify({` +
    ` versionDir: P.PRETRAINED.baseV2ProPlus, svCkpt: P.PRETRAINED.svCkpt,` +
    ` check: A.checkBaseModelsForVersion('v2ProPlus') }));`
  const env = { ...process.env, MODELS_DIR: modelsDir }
  for (const k of ['GSV_PRETRAINED_DIR', 'TTS_MODELS_DIR']) delete env[k]
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf-8' }))
}

test('⭐ 只设 MODELS_DIR 时体检就在 MODELS_DIR 底下找底模（与这一刀之前相同）', () => {
  const models = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-baseck-')), 'models')
  const empty = checkIn(models)
  assert.deepEqual(empty.check.missing, ['s2G', 's2D', 'sv'])
  assert.equal(empty.check.blocking, true, 'v2ProPlus 缺 s2G/s2D 要拦下开训')
  // 文件只摆在 lib/paths 自己算出来的那个版本目录下：两次之间只有盘上的文件变了，
  // 报齐的那个根目录因而只能是 MODELS_DIR 底下这一个，换成名片的 runtime.checkpoints 就报不齐。
  for (const fp of [path.join(empty.versionDir, 's2Gv2ProPlus.pth'),
    path.join(empty.versionDir, 's2Dv2ProPlus.pth'), empty.svCkpt]) {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, '')
  }
  const filled = checkIn(models)
  assert.deepEqual(filled.check.present, ['s2G', 's2D', 'sv'])
  assert.equal(filled.check.ok, true)
})

// 这一条钉的是「说不出来」的去向：note 进 meta（接口 JSON）与服务器日志，
// 底模下拉在界面上仍然只是空的。界面读它属于另一刀。
test('⭐ 声明写坏的那台：models 里没有它，但 meta 带一条说清为什么', () => {
  const meta = baseVoiceMeta()
  const notes = meta.assets.scan_conventions_unreadable || []
  const row = notes.find((n) => n.engine_id === 'silent-base')
  assert.ok(row, `写坏的声明没被记下来：${JSON.stringify(notes)}`)
  assert.equal(row.reason, 'invalid_scan_file')
  assert.equal(row.key, 'base_models[0].candidate', 'note 要点名写错的是哪个键')
  assert.equal(notes.find((n) => n.engine_id === 'talking-base'), undefined,
    '读得出来的那台不该被记成说不出来')
  assert.equal(meta.assets.models['silent-base'], undefined, '说不出来的那台不该占一个格子')
})
