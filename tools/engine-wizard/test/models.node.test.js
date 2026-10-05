'use strict'
// models（第 4 步）—— ⭐ 两条判据：
//   1. **一个字节都不下载**（_TEMPLATE/README.md:101）
//   2. **ready 是三态**，不许糊成布尔（checkpoints.js:84-91）
//
// ⚠ 这份测试跑在临时目录里，⛔ 绝不碰真的 models/ 目录。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describeModels, explainMissingInfo } = require('../core/models.js')

// ⛔⛔ 平台 registry 认的是自己的 ENGINES_DIR（lib/paths.js:236）。
//  ⛔ 所以这里必须先把整个夹具搬到临时目录 —— 否则测试会去碰真的 engines/。
//
// ⚠️ 变量名里必须带 mkdtemp：lib/engines/enginesDirWriteGuard.node.test.js:148
//   只看写调用的**实参文本**有没有临时痕迹，不认环境变量。
//   ⛔ 别把 ENGINES_DIR 换成别的名字。
const mkdtempEnginesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-models-eng-'))
const mkdtempModelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-models-ck-'))
process.env.ENGINES_DIR = mkdtempEnginesDir
process.env.MODELS_DIR = mkdtempModelsDir

function writeEngine (manifest, files) {
  // ⚠ 实参自带 mkdtemp 痕迹 ⇒ 守卫认得出这是临时夹具
  const mkdtempEngineDir = path.join(mkdtempEnginesDir, manifest.id)
  fs.mkdirSync(mkdtempEngineDir, { recursive: true })
  fs.writeFileSync(path.join(mkdtempEngineDir, 'manifest.json'),
    JSON.stringify(manifest))
  // 底模落在 MODELS_DIR 下（与 manifest 里的 runtime.checkpoints 一致）
  const ck = path.join(mkdtempModelsDir, 'tts', manifest.id)
  fs.mkdirSync(ck, { recursive: true })
  for (const f of (files || [])) {
    fs.writeFileSync(path.join(ck, f), 'x')
  }
  return ck
}

// ⭐ 一张「说得清齐不齐」的最小名片。必须补齐平台的其它必填段
//   （contract_version / maps / max_chars 等），否则 resolveEngineProfile 会抛。
let SEQ = 0
function manifestOk (files, opts = {}) {
  const id = `probe${++SEQ}`
  const req = files || ['model.pt']
  const m = {
    id,
    contract_version: 2,
    label: 'probe',
    upstream: { url: 'https://example.invalid/r.git', commit: null,
      commit_unknown_reason: 'test fixture' },
    runtime: { python: 'engines/' + id + '/.venv',   // ⛔ 虚拟环境目录（平台自己拼 exe）
      checkpoints: 'tts/' + id, entry: 'x.py',
      ready_endpoint: '/health', ready_timeout_ms: 1000,
      ready_timeout_ms_source: 'estimated' },
    call: { kind: 'python', module: 'm', class: 'C', method: 'go',
      bind: { text: 'text' }, returns: 'bytes' },
    input: { text: { parameter: 'text' } },
    capabilities: {
      reference_clip_seconds: null,     // ⛔ 不限制也要显式写 null（平台强制）
      output_sample_rate: 24000,        // ⛔ 平台不为它准备默认值
      requires_reference_audio: false,
      supports_finetune: false,
    },
    max_chars: 200,
    max_chars_source: 'estimated',
    timeout_ms: 1000,
    timeout_ms_source: 'estimated',
    base_url_env: 'PROBE_BASE_URL',
    default_base_url: 'http://127.0.0.1:9880',
    models: {
      required: req,
      source: { url: 'https://example.invalid/m',
        command: ['echo', 'download', '{checkpoints}'] },
    },
  }
  writeEngine(m, opts.present === null ? [] : (opts.present || req))
  return { id, m }
}

// ---------------------------------------------------------------------------
// ⭐ 三态不许糊成布尔（全部走**平台自己的** resolveEngineProfile + checkpointStatus）
// ---------------------------------------------------------------------------
test('ready:true ⇒ 文件齐了', () => {
  const { id } = manifestOk(['model.pt'])
  const r = describeModels(id, mkdtempModelsDir)
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.status.ready, true, JSON.stringify(r.status))
  // ⛔ 钉实质：说明声明的文件都在，⛔ 不钉「一个不少」这个措辞。
  assert.ok(r.notes.some((n) => /全部存在|一个不少/.test(n)), r.notes.join(' | '))
})

test('⛔ ready:false ⇒ 缺了，如实说缺', () => {
  // 名片说两个文件，磁盘上只放一个
  const { id } = manifestOk(['a.pt', 'b.pt'], { present: ['a.pt'] })
  const r = describeModels(id, mkdtempModelsDir)
  assert.strictEqual(r.status.ready, false, JSON.stringify(r.status))
  assert.ok(r.notes.some((n) => n.includes('缺')), r.notes.join(' | '))
})

test('⛔ ⭐ ready:null ⇒ 必须说「说不出来」，⛔ 不得说成齐了或缺了', () => {
  const { id } = manifestOk(['model.pt'])
  // ⛔ 关键：把两段都从磁盘上的名片里删掉 —— 平台解析出来的 profile 就说不知道
  const mkdtempEngineDir = path.join(mkdtempEnginesDir, id)
  const raw = JSON.parse(fs.readFileSync(path.join(mkdtempEngineDir, 'manifest.json'), 'utf-8'))
  delete raw.runtime.checkpoints
  delete raw.models.required
  fs.writeFileSync(path.join(mkdtempEngineDir, 'manifest.json'), JSON.stringify(raw))

  const r = describeModels(id, mkdtempModelsDir)
  assert.strictEqual(r.ok, true, r.error)
  assert.strictEqual(r.status.ready, null, JSON.stringify(r.status))
  // ⛔ 钉**实质**（状态未知），⛔ 不钉措辞：「说不出来」这类词会随文案调整。
  //   实质 = 明确说「既非完整也非缺失」，且不许出现 ready:true 的结论。
  const all = r.notes.join(' | ')
  assert.ok(/状态未知/.test(all), all)
  assert.ok(/既不能视为完整|不等于「齐了」/.test(all),
    `⛔ 必须说清「不是齐了也不是缺了」：${all}`)
  assert.ok(!/文件一个不少|全部存在/.test(all),
    `⛔ 状态未知时不得说成完整：${all}`)
  assert.ok(!/目录不存在|文件缺失/.test(all),
    `⛔ 状态未知时不得说成缺失：${all}`)
})

// ---------------------------------------------------------------------------
// ⭐ 一个字节都不下载
// ---------------------------------------------------------------------------
test('⭐ 只打印命令，不执行（目录一个字节都不动）', () => {
  const { id } = manifestOk(['model.pt'])
  const before = fs.readdirSync(path.join(mkdtempModelsDir, 'tts', id)).sort()
  const r = describeModels(id, mkdtempModelsDir)
  assert.ok(r.commands.length > 0, '⛔ 应该给出命令')
  const after = fs.readdirSync(path.join(mkdtempModelsDir, 'tts', id)).sort()
  assert.deepStrictEqual(after, before, '⛔ 这一步不许动文件')
})

test('⛔ 命令里的 {checkpoints} 由平台填成绝对路径', () => {
  const { id } = manifestOk(['model.pt'])
  const r = describeModels(id, mkdtempModelsDir)
  const joined = r.commands.join(' ')
  assert.ok(!joined.includes('{checkpoints}'), `占位符没被填：${joined}`)
  assert.ok(joined.includes('tts'), joined)
})

// ---------------------------------------------------------------------------
// ⭐ ⛔ 本文件不许出现任何下载器名（checkpoints.js:23 同一条纪律）
// ---------------------------------------------------------------------------
test('⛔ models.js 活代码里不许出现下载器名（⛔ 连注释都不许）', () => {
  const FORBIDDEN = ['modelscope', 'huggingface', 'hugging-face', 'git-lfs',
    'wget', 'aria2c', 'hf_hub', 'snapshot_download']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'models.js'), 'utf-8')
  for (const bad of FORBIDDEN) {
    assert.ok(!src.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

test('⛔ models.js 里不许出现任何具体引擎名', () => {
  const FORBIDDEN = ['gpt' + '-sovits', 'index' + 'tts2', 'cosy' + 'voice',
    'vox' + 'cpm']
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'models.js'), 'utf-8')
  for (const bad of FORBIDDEN) {
    assert.ok(!src.toLowerCase().includes(bad), `出现了「${bad}」`)
  }
})

// ---------------------------------------------------------------------------
// 名片缺字段时的提示
// ---------------------------------------------------------------------------
test('⭐ 缺 checkpoints / required 要分别说清后果', () => {
  const gaps = explainMissingInfo({ runtime: {}, models: {} })
  assert.strictEqual(gaps.length, 2)
  const byKey = Object.fromEntries(gaps.map((g) => [g.key, g]))
  // ⛔ 钉实质：checkpoints 缺失时只能说「目录在不在」，⛔ 不钉字面。
  assert.ok(/只能.*目录|无法判断是否完整/.test(byKey['runtime.checkpoints'].why),
    byKey['runtime.checkpoints'].why)
  // ⛔ 钉实质：required 缺失时必须点明结果是「无法判断」这一状态。
  assert.ok(/状态未知|无法判断/.test(byKey['models.required'].why),
    byKey['models.required'].why)
  for (const g of gaps) assert.ok(g.example, `${g.key} 没有例子`)
})

test('两段都写了 ⇒ 没有缺口', () => {
  assert.strictEqual(
    explainMissingInfo({ runtime: { checkpoints: 'tts/x' }, models: { required: ['a'] } }).length,
    0)
})

// ---------------------------------------------------------------------------
// ⛔ 名片有问题时报出来，不静默
// ---------------------------------------------------------------------------
test('⛔ 名片读不出来 ⇒ 如实报 NO_PROFILE', () => {
  const r = describeModels('definitely-not-installed-xyz', process.env.MODELS_DIR)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_PROFILE')
  // ⛔ 原断言要求「指向第 5 步」，⛔ 那是错的：
  //   describeModels 跑在第 3 步，而 Manifest 第 4 步才写
  //   ⇒ 让用户「去第 5 步检查」指向一个还不存在的 Manifest。
  //
  // ⛔ 本测试用的引擎**未安装**，走的是「未安装」分支 ⇒ 该分支只说
  //   「未安装 + 已装的是谁」，⛔ 不指向任何步骤（下一步是第 1 步，
  //   但那由流程顺序保证，不需要文案再说一遍）。
  //   「已安装但解析失败」才指向第 4 步 —— 见下一条测试。
  assert.ok(/未安装/.test(r.error), r.error)
  assert.ok(!r.error.includes('第 5 步'),
    `⛔ 不得指向第 5 步（此时 Manifest 还没写）：${r.error}`)
})

// ⛔ 两种失败原因必须分开说，⛔ 且各自的「下一步」不同：
//   · 未安装        ⇒ 下一步是第 1 步（流程顺序已保证，文案不必再说）
//   · 已装但解析失败 ⇒ 下一步是第 4 步（保存 Manifest 时 validate() 当场报）
// ⛔ 混成一句话 ⇒ 用户会去一个还没写的 Manifest 上找问题。
test('⛔ 已安装但 Manifest 解析失败 ⇒ 指向第 4 步，⛔ 不是第 5 步', () => {
  const { id } = manifestOk(['model.pt'])
  const mkdtempEngineDir = path.join(mkdtempEnginesDir, id)
  const raw = JSON.parse(fs.readFileSync(path.join(mkdtempEngineDir, 'manifest.json'), 'utf-8'))
  // 顶层键不认识 ⇒ profile.js 会抛错，但**目录存在**（不是「未安装」）
  raw.zzz_not_a_real_top_level_key = 1
  fs.writeFileSync(path.join(mkdtempEngineDir, 'manifest.json'), JSON.stringify(raw))

  const r = describeModels(id, mkdtempModelsDir)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.code, 'NO_PROFILE')
  assert.ok(r.error.includes('第 4 步'),
    `⛔ 解析失败应指向第 4 步（保存时会当场报）：${r.error}`)
  assert.ok(!r.error.includes('第 5 步'),
    `⛔ 不得指向第 5 步：${r.error}`)
  assert.ok(!r.error.includes('未安装'),
    `⛔ 该引擎目录存在，不得说成「未安装」：${r.error}`)
})

// ---------------------------------------------------------------------------
// 命令缺失时不许编一个
// ---------------------------------------------------------------------------
test('⛔ 名片没写 source.command ⇒ 说「没有命令可打印」，⛔ 不自己造', () => {
  const { id } = manifestOk(['model.pt'])
  const mkdtempEngineDir = path.join(mkdtempEnginesDir, id)
  const raw = JSON.parse(fs.readFileSync(path.join(mkdtempEngineDir, 'manifest.json'), 'utf-8'))
  delete raw.models.source.command
  fs.writeFileSync(path.join(mkdtempEngineDir, 'manifest.json'), JSON.stringify(raw))

  const r = describeModels(id, mkdtempModelsDir)
  assert.strictEqual(r.ok, true, r.error)
  assert.deepStrictEqual(r.commands, [], '⛔ 不能凭空造一条下载命令')
  const all = r.notes.join(' | ')
  // ⛔ 钉实质：说明「无命令可显示」+ 给出下一步，⛔ 不钉「没有命令可以打印」这七个字。
  assert.ok(/无命令|没有命令/.test(all), all)
  assert.ok(/Manifest/.test(all) && /补充|自行下载/.test(all),
    `⛔ 必须说清下一步（在 Manifest 补命令，或自行下载）：${all}`)
})

test('⚠ 许可门槛要显示出来（有的仓库要先去网站点同意）', () => {
  const { id } = manifestOk(['model.pt'])
  const mkdtempEngineDir = path.join(mkdtempEnginesDir, id)
  const raw = JSON.parse(fs.readFileSync(path.join(mkdtempEngineDir, 'manifest.json'), 'utf-8'))
  raw.models.source.license_gate = true   // ⛔ 布尔，不是字符串（profile.js:613）
  fs.writeFileSync(path.join(mkdtempEngineDir, 'manifest.json'), JSON.stringify(raw))
  const r = describeModels(id, mkdtempModelsDir)
  // ⛔ 钉实质：必须提到许可协议 + 未接受时的症状，⛔ 不钉「网站点同意」这个措辞。
  assert.ok(r.notes.some((n) => /许可/.test(n) && /401|403/.test(n)),
    r.notes.join(' | '))
})
