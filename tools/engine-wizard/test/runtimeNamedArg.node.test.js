const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 运行期资源的仓库标识不一定写在下载调用那一行。常见的另一种写法是
//   把仓库 id 放在函数形参默认值或模块常量里，调用处只传变量名。
//   这一组守卫盯住两件事：这类写法要列出来，无关字面量不能混进来。

const ROOT = path.resolve(__dirname, '..', '..', '..')
const { scanRuntimeDownloads } = require(
  path.join(ROOT, 'tools', 'engine-wizard', 'core', 'wizardbridge.js'))

function plant (lines, name = 'core.py') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-runtime-arg-'))
  fs.writeFileSync(path.join(dir, name), lines.join('\n'))
  return dir
}

function repos (dir) {
  try { return scanRuntimeDownloads(dir).map((h) => h.repo) } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('下载调用只传变量时，函数形参默认值里的仓库标识要列出', () => {
  const dir = plant([
    'from huggingface_hub import snapshot_download',
    'def resolve(path_or_id):',
    '    return snapshot_download(',
    '        repo_id=path_or_id,',
    '    )',
    'class TTS:',
    '    @classmethod',
    '    def from_pretrained(',
    '        cls,',
    '        hf_model_id: str = "openbmb/VoxCPM2",',
    '        zipenhancer_model_id: str = "iic/speech_zipenhancer",',
    '    ):',
    '        return resolve(hf_model_id)',
  ])
  assert.deepStrictEqual(repos(dir),
    ['openbmb/VoxCPM2', 'iic/speech_zipenhancer'])
})

test('仓库标识写在下载调用之前的模块常量里也要列出', () => {
  const dir = plant([
    'from huggingface_hub import snapshot_download',
    'DEFAULT_HF_MODEL_ID = "org/weights"',
    'def load(model_id=DEFAULT_HF_MODEL_ID):',
    '    return snapshot_download(repo_id=model_id)',
  ])
  assert.deepStrictEqual(repos(dir), ['org/weights'])
})

test('多行具名实参仍是第一判据，窗口里的日志文字不顶替', () => {
  const dir = plant([
    'def load(self):',
    '    path = snapshot_download(',
    '        repo_id="2Noise/ChatTTS",',
    '    )',
    '    log("https://huggingface.co/org/LogoOnly")',
  ])
  assert.deepStrictEqual(repos(dir), ['2Noise/ChatTTS'])
})

test('参数名不带模型语义的斜杠字面量不算仓库', () => {
  const dir = plant([
    'from huggingface_hub import snapshot_download',
    'OUTPUT_DIR = "reports/weekly"',
    'def load():',
    '    return snapshot_download(repo_id=DEFAULT_ID)',
  ])
  assert.deepStrictEqual(repos(dir), [])
})

test('本地目录形态的默认值按旧口径排除', () => {
  const dir = plant([
    'from huggingface_hub import snapshot_download',
    'MODEL_PATH = "checkpoints/local-model"',
    'def load():',
    '    return snapshot_download(repo_id=MODEL_PATH)',
  ])
  assert.deepStrictEqual(repos(dir), [])
})

test('同一仓库在常量与形参里各写一次只列一条', () => {
  const dir = plant([
    'from huggingface_hub import snapshot_download',
    'DEFAULT_HF_MODEL_ID = "org/weights"',
    'def load(hf_model_id=DEFAULT_HF_MODEL_ID):',
    '    return snapshot_download(repo_id=hf_model_id)',
    'def build(hf_model_id: str = "org/weights"):',
    '    return from_pretrained(hf_model_id)',
  ])
  assert.deepStrictEqual(repos(dir), ['org/weights'])
})

test('文件里没有下载类调用时不做文件级补档', () => {
  const dir = plant([
    'DEFAULT_HF_MODEL_ID = "org/weights"',
    'def build():',
    '    return DEFAULT_HF_MODEL_ID',
  ])
  assert.deepStrictEqual(repos(dir), [])
})
