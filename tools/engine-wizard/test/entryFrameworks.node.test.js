'use strict'
// 声明式命令行框架（click / typer / fire）的参数扫描。
//
// 这三种框架的参数不在 add_argument 里，静态解析原先一条都读不到：
// 文件被找到了、参数表为空，入口判定拿不到任何证据，discover 只能说
// 「没有可识别的参数」。这一组用例锁住「三种声明形式都读得到、字段对得上」。
//
// 用夹具而不是真引擎：要验的是声明形式，真引擎会随上游改版漂移。
// 夹具源码写的是最小可解析的声明，不含任何具体引擎的名字。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { collectCliHelp } = require('../core/cliHelp')
const { buildCliDraft } = require('../core/cliDraft')
const { pickEntry } = require('../core/entryPick')

const PYTHON = ['python3', 'python'].find((cmd) => {
  try { return spawnSync(cmd, ['--version'], { timeout: 10000 }).status === 0 } catch { return false }
}) || null
const skip = PYTHON ? false : '本机没有 Python'

const CLICK = `import click

@click.command()
@click.option("--text", required=True, help="text to synthesize")
@click.option("--ref-audio", "-r", help="reference audio")
@click.option("--output-path", help="where to write the audio")
@click.option("--model", help="weights to load")
@click.option("--fp16", is_flag=True, help="half precision")
def main(text, ref_audio, output_path, model, fp16):
    pass

if __name__ == "__main__":
    main()
`

const TYPER = `import typer
from typing import Optional

def main(
    text: str = typer.Option(..., "--text", help="text to synthesize"),
    ref_audio: Optional[str] = typer.Option(None, "--ref-audio"),
    output_path: Optional[str] = typer.Option(None, "--output-path"),
    model: Optional[str] = typer.Option(None, "--model"),
):
    pass

app = typer.Typer()
app.command()(main)

if __name__ == "__main__":
    app()
`

const TYPER_ANNOTATED = `import typer
from typing import Annotated

def main(
    text: Annotated[str, typer.Option("--text")],
    output_path: Annotated[str, typer.Option("--output-path")] = None,
):
    pass
`

const FIRE = `import fire

def main(text, ref_audio=None, output_path=None, model=None):
    """Synthesize speech."""
    pass

if __name__ == "__main__":
    fire.Fire(main)
`

// 造一棵临时引擎目录，返回根路径。
function planted (files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frameworks-')))
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body, 'utf8')
  }
  return root
}

/** 扫一遍，并算出名片草稿里的参数名。 */
function scan (body, file = 'inference.py') {
  const root = planted({ [file]: body })
  try {
    const help = collectCliHelp({ dir: root })
    const draft = buildCliDraft(help)
    return { help, draft, names: (draft.args || []).map((a) => a.name) }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('click：@click.option 的四个开关都读得到，必填与开关型也标对', { skip }, () => {
  const { names, draft } = scan(CLICK)
  assert.deepStrictEqual(names, ['text', 'ref-audio', 'output-path', 'model', 'fp16'])

  const byName = Object.fromEntries((draft.args || []).map((a) => [a.name, a]))
  assert.strictEqual(byName.text.required, true, 'required=True 要读进来')
  assert.strictEqual(byName.text.help, 'text to synthesize', 'help 是上游原话，逐字递出')
  assert.strictEqual(byName.text.flag, '--text')
  assert.strictEqual(byName.fp16.style, 'boolean', 'is_flag=True 是开关型，不是带值型')
  assert.strictEqual(byName['ref-audio'].required, false)
})

test('typer：默认值形式的 Option 读得到，... 表示必填', { skip }, () => {
  const { names, draft } = scan(TYPER)
  assert.deepStrictEqual(names, ['text', 'ref-audio', 'output-path', 'model'])
  const byName = Object.fromEntries((draft.args || []).map((a) => [a.name, a]))
  assert.strictEqual(byName.text.required, true, '默认值是 ... 就是必填')
  assert.strictEqual(byName.text.help, 'text to synthesize')
  assert.strictEqual(byName.model.required, false)
})

test('typer：Annotated 形式也认', { skip }, () => {
  const { names, draft } = scan(TYPER_ANNOTATED)
  assert.deepStrictEqual(names, ['text', 'output-path'])
  const byName = Object.fromEntries((draft.args || []).map((a) => [a.name, a]))
  assert.strictEqual(byName.text.required, false, 'Annotated 里没写 ... 时按可选处理')
  assert.strictEqual(byName.text.flag, '--text')
})

test('fire：Fire(main) 指向的函数签名就是命令行参数', { skip }, () => {
  const { names, draft } = scan(FIRE)
  assert.deepStrictEqual(names, ['text', 'ref-audio', 'output-path', 'model'])
  const byName = Object.fromEntries((draft.args || []).map((a) => [a.name, a]))
  assert.strictEqual(byName.text.required, true, '没有默认值就是必填')
  assert.strictEqual(byName.text.flag, '--text', 'fire 也认 --name 形式')
  assert.strictEqual(byName.model.required, false)
})

test('三种框架扫出来的参数足够认出推理入口（四类齐全）', { skip }, () => {
  for (const body of [CLICK, TYPER, FIRE]) {
    const root = planted({ 'inference.py': body })
    try {
      const help = collectCliHelp({ dir: root })
      const draft = buildCliDraft(help)
      const params = (draft.args || []).map((a) => ({
        source: 'cli', name: a.name, target: a.flag, kind: a.type || 'str',
        style: a.style, required: a.required === true,
        group: a.subcommand || '(root)', is_tool: a.is_tool === true,
        source_file: a.source_file || null,
      }))
      const entry = pickEntry(params)
      assert.strictEqual(entry.file, 'inference.py')
      assert.strictEqual(entry.score, 4, '文本 / 参考音频 / 输出 / 模型四类都要认出')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('argparse 的文件不受影响：不该被框架解析器抢走', { skip }, () => {
  const body = `import argparse
p = argparse.ArgumentParser()
p.add_argument("--text", required=True)
p.add_argument("--output_path")
if __name__ == "__main__":
    p.parse_args()
`
  const { names } = scan(body)
  assert.deepStrictEqual(names, ['text', 'output_path'], 'argparse 的名字保持原样（下划线），不被改成横线')
})
