const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

// 画布界面文案的口语守卫：用户读到的中文必须是书面语。
// 判据是一张写死的口语词表，逐行扫指定的文件与目录，覆盖节点名、端口名、
// 拒绝的话、运行状态与校验结果。表里只收具体的口语说法，不评语气：
// 评语气只会引出争论，不会给出失败。
const BANNED = [
  { bad: '开跑', use: '运行 / 开始运行' },
  { bad: '没开跑', use: '未开始运行' },
  { bad: '没接东西', use: '未连接' },
  { bad: '接不上', use: '类型不匹配 / 无法连接' },
  { bad: '过没过', use: '结果（通过 / 未通过）' },
  { bad: '存好了', use: '已保存 / 已写入' },
  { bad: '存不下来', use: '保存失败' },
  { bad: '停下来等人', use: '需人工介入' },
  { bad: '拔掉', use: '断开连接' },
  { bad: '出口', use: '输出端口' },
  { bad: '入口', use: '输入端口' },
  { bad: '开工', use: '开始执行' },
  { bad: '干活', use: '执行' },
  { bad: '搞定', use: '完成' },
  { bad: '弄好', use: '完成 / 配置完成' },
  { bad: '咋', use: '如何' },
  { bad: '没啥', use: '没有' },
  { bad: '嗓子', use: '音色' },
  { bad: '跑之前', use: '运行前' },
  { bad: '跑不了', use: '无法执行' },
  { bad: '认不出来', use: '无法识别' },
  { bad: '没成功', use: '执行失败' },
  { bad: '找不到了', use: '不存在 / 无法访问' },
  // 这几条是补进表里的：一句刻意说口语的话（"这台机器没地方存音色，弄不了"）
  // 能绕过前面那几条。绕得过去的守卫不是守卫。
  { bad: '弄不了', use: '无法执行 / 不支持' },
  { bad: '没地方', use: '未提供 / 未配置' },
  { bad: '这台机器', use: '本机' },
]

// 用户会读到的中文：节点文案的唯一出处、措辞拒绝的地方，以及画布本身。
const FILES = [
  'lib/flowgraph/docs.js',
  'lib/flowgraph/engine.js',
  'lib/flowgraph/adapter.js',
  // nodes.js 是节点运行期间抛出拒绝的地方：漏掉它，
  // 别的检查都抓不到那里留下的口语句子。
  'lib/flowgraph/nodes.js',
]

// 画布目录整体读：组件按功能拆成多个文件后，只读 FlowCanvasTab.jsx
// 会看不见拆出去的部分，守卫静默失效。
const DIRS = [
  'web/src/components/flowgraph',
]

const ROOT = path.join(__dirname, '..', '..')

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

const { readDirSources } = require('../__testsupport__/readDirSources.cjs')

test('user-facing Chinese stays in written register', () => {
  const found = []
  const scan = (label, source) => {
    const lines = source.split(/\r?\n/)
    lines.forEach((line, i) => {
      // 注释不会显示到屏幕上，只判能显示的文字。
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
      for (const entry of BANNED) {
        if (line.includes(entry.bad)) {
          found.push(`${label}:${i + 1} 出现口语「${entry.bad}」，应改用：${entry.use}`)
        }
      }
    })
  }
  for (const relative of FILES) scan(relative, read(relative))
  for (const dir of DIRS) scan(dir, readDirSources(path.join(ROOT, dir)))
  assert.deepEqual(found, [], `\n${found.join('\n')}`)
})

test('every node, port and setting is explained in both languages', () => {
  // 半翻译的界面比不翻译更糟：它看起来已经做完了。
  // 这些句子只存在于 docs.js，所以只需检查那一处。
  const { NODE_DOCS } = require('./docs')
  const holes = []
  for (const [type, doc] of Object.entries(NODE_DOCS)) {
    const check = (what, value) => {
      if (!value) return
      if (typeof value !== 'object') return
      if (!value.en || !value.zh) holes.push(`${type} → ${what}`)
    }
    check('label', doc.label)
    check('help', doc.help)
    for (const [name, port] of Object.entries(doc.inputs || {})) {
      check(`input ${name}.label`, port.label)
      check(`input ${name}.help`, port.help)
    }
    for (const [name, port] of Object.entries(doc.outputs || {})) {
      check(`output ${name}.label`, port.label)
      check(`output ${name}.help`, port.help)
    }
    for (const [name, param] of Object.entries(doc.params || {})) {
      check(`param ${name}.label`, param.label)
      check(`param ${name}.help`, param.help)
    }
  }
  assert.deepEqual(holes, [], `\n${holes.join('\n')}`)
})
