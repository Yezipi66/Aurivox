'use strict'
// 第 3 步第一档：引擎自带入口的发现与占位符展开。
//   平台只负责找出来、执行、显示进度；命令内容由名片或上游脚本自己决定。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildEngineDownloadEntries, expandEngineArgv,
  scanEngineScriptCandidates, scanRuntimeDownloads, scanDocDownloadCommands,
} = require('../core/wizardbridge')

function plant (opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-entries-'))
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  const manifest = { id: 'demo', runtime: { checkpoints: 'engines/demo/checkpoints' }, models: { required: [] } }
  if (opts.post) manifest.models.post_download = { command: opts.post }
  if (opts.scripts) for (const f of opts.scripts) fs.writeFileSync(path.join(dir, f), '')
  if (opts.venv) fs.mkdirSync(path.join(dir, '.venv'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return { root, dir, manifest }
}

test('名片声明优先于脚本；安装脚本要标出可能已在第 2 步部署', () => {
  const post = ['{engine_python}', '-c', "ensure('{checkpoints}')"]
  const { root } = plant({ post, scripts: ['install.sh', 'download.sh'], venv: true })
  const entries = buildEngineDownloadEntries(root, 'demo')
  assert.strictEqual(entries[0].key, 'manifest', '名片声明排第一')
  const inst = entries.find((e) => e.key === 'script:install.sh')
  assert.ok(inst)
  assert.strictEqual(inst.installs_env, true)
  assert.strictEqual(inst.already_deployed, true)
  const dl = entries.find((e) => e.key === 'script:download.sh')
  assert.strictEqual(dl.installs_env, false)
})

test('展开占位符后不留下未展开的 token，权重目录用正斜杠', () => {
  const post = ['{engine_python}', '-c', "ensure('{checkpoints}')", '{engine_dir}']
  const { root, dir, manifest } = plant({ post })
  const argv = expandEngineArgv(post, root, 'demo', dir, manifest)
  assert.ok(!argv.some((w) => /\{[a-z_]+\}/.test(w)))
  assert.ok(argv[2].includes('/engines/demo/checkpoints'))
  assert.ok(!argv[2].includes('\\'))
  assert.ok(argv[3].endsWith('/engines/demo'))
})

test('引擎目录不存在时返回空清单，不抛', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-entries-empty-'))
  assert.deepStrictEqual(buildEngineDownloadEntries(root, 'missing'), [])
})

test('子目录里的下载脚本进入第一档，根目录固定名字不重复列出', () => {
  const { root } = plant({ scripts: ['download.sh'] })
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pkg', 'download.py'), '')
  fs.mkdirSync(path.join(dir, 'examples'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'examples', 'download_ljspeech.sh'), '')
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'runtime', 'convert_checkpoint.py'), '')
  const entries = buildEngineDownloadEntries(root, 'demo')
  const keys = entries.map((e) => e.key)
  assert.ok(keys.includes('script:download.sh'))
  assert.ok(keys.includes('script:pkg/download.py'))
  assert.ok(!keys.some((k) => k.startsWith('script:examples/')))
  assert.ok(!keys.some((k) => k.startsWith('script:runtime/')))
  assert.strictEqual(keys.filter((k) => k === 'script:download.sh').length, 1)
  const sub = entries.find((e) => e.key === 'script:pkg/download.py')
  assert.strictEqual(sub.needs_review, true)
  assert.strictEqual(sub.argv[1], 'pkg/download.py', '子目录脚本用相对路径，工作目录是引擎目录')
})

test('子目录扫描只读文件名，不把训练数据脚本列成候选', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-scan-'))
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'pkg', 'download_weights.py'), '')
  fs.writeFileSync(path.join(dir, 'pkg', 'download_and_untar.sh'), '')
  fs.writeFileSync(path.join(dir, 'pkg', 'convert_checkpoint.py'), '')
  assert.deepStrictEqual(scanEngineScriptCandidates(dir), ['pkg/download_weights.py'])
})

test('启动自动下载：只认带仓库标识的下载调用，本地路径与格式化字符串不算', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-runtime-'))
  fs.writeFileSync(path.join(dir, 'model.py'), [
    'from huggingface_hub import snapshot_download',
    "snapshot_download('org/model-repo', local_dir=cache)",
    "m = AutoModel.from_pretrained(f'{root}/LLM')",
    "x = hf_hub_download(repo_id='org/another', filename='a.bin')",
    "y = load('org/not-a-download')",
  ].join('\n'))
  const hints = scanRuntimeDownloads(dir)
  assert.deepStrictEqual(hints.map((h) => h.repo).sort(), ['org/another', 'org/model-repo'])
  assert.ok(hints.every((h) => h.file === 'model.py' && h.line > 0 && h.call))
})

test('启动自动下载：本地目录不算仓库，同一仓库只列一次', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-runtime-'))
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.py'), [
    "snapshot_download('org/model-repo')",
    "snapshot_download('checkpoints/agent-0.6b-debug')",
    "hf_hub_download(repo_id='hfl/chinese-roberta-wwm-ext-large')",
  ].join('\n'))
  fs.writeFileSync(path.join(dir, 'pkg', 'b.py'), "snapshot_download('org/model-repo')")
  const hints = scanRuntimeDownloads(dir)
  assert.deepStrictEqual(hints.map((h) => h.repo),
    ['org/model-repo', 'hfl/chinese-roberta-wwm-ext-large'])
})

test('运行期资源：多行调用把 repo_id 写在下一行也要认出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-runtime-'))
  fs.writeFileSync(path.join(dir, 'core.py'), [
    'def load(self):',
    '    download_path = snapshot_download(',
    '        repo_id="2Noise/ChatTTS",',
    '        allow_patterns=["*.json"],',
    '    )',
    '    log("https://huggingface.co/2Noise/ChatTTS")',
  ].join('\n'))
  const hints = scanRuntimeDownloads(dir)
  assert.deepStrictEqual(hints.map((h) => h.repo), ['2Noise/ChatTTS'])
  assert.strictEqual(hints[0].call, 'snapshot_download')
})

test('运行期资源：窗口里的 URL 与本地目录不顶替仓库标识', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-runtime-'))
  fs.writeFileSync(path.join(dir, 'core.py'), [
    'snapshot_download(',
    '    "checkpoints/local-model",',
    '    log("https://huggingface.co/org/LogoOnly")',
    ')',
  ].join('\n'))
  assert.deepStrictEqual(scanRuntimeDownloads(dir), [])
})

// 有一类引擎不带下载命令、也不写下载脚本：它在运行时用 huggingface_hub 按需取权重，
//   落点是 HF 缓存而不是引擎目录的 checkpoints。第 3 步此前对它是空的。
function plantRuntimeFetcher (opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-hf-'))
  const dir = path.join(root, 'engines', 'demo')
  fs.mkdirSync(dir, { recursive: true })
  // 文件名不能带 download / fetch / install 这些词：那样会先被当成「下载脚本」，
  //   就走不到运行时拉取那一条了。真实情况也是这样，引擎把下载写在普通模块里。
  fs.mkdirSync(path.join(dir, 'demo'))
  fs.writeFileSync(path.join(dir, 'demo', 'helpers.py'), [
    'from huggingface_hub import hf_hub_download',
    "LANGS = {'EN': 'org/demo-en', 'ZH': 'org/demo-zh'}",
    'def ensure(lang):',
    "    return hf_hub_download(repo_id=LANGS[lang], filename='ckpt.pth')",
  ].join('\n'))
  const manifest = { id: 'demo', models: { required: opts.required || [] } }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return root
}

test('「语言 → 仓库」映射里的仓库也算运行时拉取', () => {
  const root = plantRuntimeFetcher()
  try {
    const hints = scanRuntimeDownloads(path.join(root, 'engines', 'demo'))
    const repos = hints.map((h) => h.repo)
    assert.deepStrictEqual(repos, ['org/demo-en', 'org/demo-zh'],
      '映射的值没被扫到：这类文件里仓库名不写在调用的实参上')
    assert.strictEqual(hints[0].via, 'mapping-value')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('没有任何自带入口时，给一条「预下载到 HF 缓存」的可执行条目', () => {
  const root = plantRuntimeFetcher()
  try {
    const entries = buildEngineDownloadEntries(root, 'demo')
    assert.strictEqual(entries.length, 2, '两个仓库各给一条')
    assert.strictEqual(entries[0].kind, 'hf-runtime')
    assert.strictEqual(entries[0].key, 'hf:org/demo-en')
    assert.ok(entries[0].argv.includes("from huggingface_hub import snapshot_download; snapshot_download('org/demo-en')"),
      '命令要真的能把仓库取到本机')
    assert.match(entries[0].noteZh, /HF 缓存/,
      '落点与平台判定不一致这件事必须写出来，否则用户会以为第 3 步没生效')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('名片已经声明了权重清单时，不补预下载条目', () => {
  const root = plantRuntimeFetcher({ required: ['ckpt.pth'] })
  try {
    assert.deepStrictEqual(buildEngineDownloadEntries(root, 'demo'), [],
      '名片说了权重要落盘，就该走模型仓库那条路，别混进来自动拉缓存')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 上游把「装完依赖后还要敲的命令」写在 docs/install.md 里（MeloTTS 的
// `python -m unidic download`），第 2 步只按依赖清单装，第 3 步此前也没有它。
test('安装文档里的资源下载命令被列成可执行条目', () => {
  const root = plantRuntimeFetcher()
  try {
    const dir = path.join(root, 'engines', 'demo')
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'install.md'),
      '# Install\npip install -e .\npython -m unidic download\n')
    const cmds = scanDocDownloadCommands(dir)
    assert.strictEqual(cmds.length, 1, 'pip install 不该被当成资源下载命令')
    assert.deepStrictEqual(cmds[0].argv, ['{engine_python}', '-m', 'unidic', 'download'])
    const entries = buildEngineDownloadEntries(root, 'demo')
    const doc = entries.find((e) => e.kind === 'doc-command')
    assert.ok(doc, '文档命令没进第 3 步的可执行清单')
    assert.match(doc.noteZh, /docs\/install\.md:3/, '没写清来源，接入者没法核对')
    // 文档命令不能挡住运行时 HF 权重的兜底条目。
    assert.ok(entries.some((e) => e.kind === 'hf-runtime'),
      '⛔ 只列了词典命令，主权重的预下载入口又被挡掉了')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('文档里的示例用法不会被当成安装命令', () => {
  const root = plantRuntimeFetcher()
  try {
    const dir = path.join(root, 'engines', 'demo')
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.writeFileSync(path.join(dir, 'docs', 'install.md'),
      'python -m demo download "some text" out.wav\n')
    assert.deepStrictEqual(scanDocDownloadCommands(dir), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

// 配套仓库（特征提取、语音识别、分词器、声码器）不是主权重。下载清单只列前几条，
// 它们排在最前面时，真正要下的大仓库根本进不了清单。
test('预下载优先主权重，配套仓库排在后面但仍列出', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-hf-aux-'))
  try {
    const dir = path.join(root, 'engines', 'demo')
    fs.mkdirSync(path.join(dir, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'demo', 'helpers.py'), [
      'from huggingface_hub import snapshot_download',
      "ASR_MODEL = 'facebook/hubert-base-ls960'",
      "TTS_MODEL = 'org/demo-tts-v1'",
      'def ensure():',
      '    return snapshot_download(TTS_MODEL)',
    ].join('\n'))
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'demo', models: { required: [] } }))
    const entries = buildEngineDownloadEntries(root, 'demo')
    assert.strictEqual(entries[0].key, 'hf:org/demo-tts-v1',
      '主权重没排在第一位：配套仓库会把清单名额占掉')
    // 有同名仓库时清单只列同名那批（多语言引擎一个语言一条），配套仓库不占名额。
    assert.strictEqual(entries.length, 1,
      '配套仓库不该占下载清单的名额')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
