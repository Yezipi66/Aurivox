'use strict'
// python 形态的入口候选：静态扫描类与方法，不导入任何模块。
//   判据与命令行那条线同一套：收文本、参考音频、输出落点、模型这四类里至少两类，且收文本。

const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { scanClasses, scanPythonEntries } = require('../core/pyClassScan')

const SRC = `
# 一个典型的库形态引擎：合成入口藏在类里，命令行上是看不到的
class TTS:

    def __init__(self, model_dir=None, device="cpu"):
        self.model = model_dir

    def synthesize(self, text, output_path, reference_audio=None, seed=42):
        pass

    def load_later(self, text):
        pass

class Helper:
    def format(self, name):
        pass
`

test('类与方法读得出来，参数名剥掉注解与默认值', () => {
  const classes = scanClasses(SRC)
  assert.deepStrictEqual(classes.map((c) => c.name), ['TTS', 'Helper'])
  const synth = classes[0].methods.find((m) => m.name === 'synthesize')
  assert.deepStrictEqual(synth.params, ['text', 'output_path', 'reference_audio', 'seed'])
  assert.deepStrictEqual(classes[0].methods.find((m) => m.name === '__init__').params,
    ['model_dir', 'device'])
})

test('方法签名跨行也读得全', () => {
  const text = [
    'class A:',
    '    def infer(',
    '        self,',
    '        text: str,',
    '        out_dir: str = "out",',
    '    ) -> None:',
    '        pass',
  ].join('\n')
  const m = scanClasses(text)[0].methods[0]
  assert.strictEqual(m.name, 'infer')
  assert.deepStrictEqual(m.params, ['text', 'out_dir'])
})

/** 造一台假引擎：只写磁盘，不碰真 engines/。 */
function plant (files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurivox-pyentry-'))
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text, 'utf8')
  }
  return dir
}

test('⭐ 只有同时收文本与落点的方法才进候选', () => {
  const dir = plant({
    'engine/tts.py': SRC,
    'engine/__init__.py': '',
    'engine/utils.py': 'def add(a, b):\n    return a + b\n',
  })
  const out = scanPythonEntries(dir)
  assert.strictEqual(out.length, 1, '只该有 synthesize 一条')
  assert.strictEqual(out[0].module, 'engine.tts')
  assert.strictEqual(out[0].className, 'TTS')
  assert.strictEqual(out[0].method, 'synthesize')
  assert.deepStrictEqual(out[0].params.text, ['text'])
  assert.deepStrictEqual(out[0].params.out, ['output_path'])
})

test('常见方法名排在前面，得分相同的时候也一样', () => {
  const dir = plant({
    'a.py': [
      'class A:',
      '    def run(self, text, output_path):',
      '        pass',
      '    def synthesize(self, text, output_path):',
      '        pass',
    ].join('\n'),
  })
  const out = scanPythonEntries(dir)
  assert.strictEqual(out[0].method, 'synthesize')
})

test('src 布局的模块名要剥掉 src', () => {
  const dir = plant({
    'src/pkg/model.py': SRC,
  })
  const out = scanPythonEntries(dir)
  assert.strictEqual(out[0].module, 'pkg.model')
  assert.strictEqual(out[0].srcRoot, 'src')
})

test('目录不存在时返回空数组，不抛', () => {
  assert.deepStrictEqual(scanPythonEntries(path.join(os.tmpdir(), 'aurivox-not-here-9f')), [])
})
