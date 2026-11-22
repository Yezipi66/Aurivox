// 下载命令的跨平台形状守卫（双平台矩阵各跑一次）。
//
// 为什么要有这条：第 3 步的下载命令在本地（Windows）生成，换到 Linux 上
// 形状必须一起对：解释器路径（Scripts\python.exe vs bin/python）、
// 可执行后缀（.exe vs 无）。这类差异在 Windows 上永远测不出来，
// 只能靠另一个平台的 CI 守。
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CORE = path.resolve(__dirname, '..', 'core')
const wb = require(path.join(CORE, 'wizardbridge.js'))

test('下载命令按平台生成：Windows 用 Scripts/python.exe 或 .exe，posix 用 bin/python 且不含 .exe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-shape-'))
  try {
    const dir = path.join(root, 'engines', 'demo')
    fs.mkdirSync(dir, { recursive: true })
    // README 里一条魔搭命令：扫描器该认出它并转义成可执行命令
    fs.writeFileSync(path.join(dir, 'README.md'), [
      '# demo',
      '',
      '```python',
      'from modelscope import snapshot_download',
      "snapshot_download('iic/CosyVoice2-0.5B', local_dir='pretrained_models/x')",
      '```',
      '',
    ].join('\n'))

    const list = wb.buildEngineDownloadEntries(root, 'demo')
    const cmds = list.filter((e) => Array.isArray(e.argv) && e.argv.length)
    assert.ok(cmds.length > 0, '一条可执行命令都没生成 —— 扫描器或转义至少一处失效')

    for (const e of cmds) {
      const s = e.argv.join(' ')
      if (process.platform === 'win32') {
        assert.match(s, /(?:Scripts[\\/]python\.exe|\.exe)/,
          `Windows 命令该用平台解释器或 .exe：${e.labelZh} -> ${s}`)
      } else {
        assert.match(s, /bin\/python/,
          `posix 命令该用 venv/bin/python：${e.labelZh} -> ${s}`)
        assert.doesNotMatch(s, /\.exe/,
          `posix 命令不该出现 .exe：${e.labelZh} -> ${s}`)
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
