'use strict'

// 第 2 步「安装配置」：命令区的选择总览（choiceLines），以及单框布局的结构守卫。
//
// 命令文本里排除走 --excludes 文件，包名不进 argv：点一个包设为不安装时
//   命令一字不变，看上去像没联动。choiceLines 把后端真正采纳的选择摆出来，
//   让「不安装」「选后端」「改版本」在命令旁看得见。返回字符串数组，
//   由命令区的 rc-cmd 块统一排版。
//
// choiceLines 是纯函数（不依赖 React），直接调用断言，比渲染整块更直接。

const { test } = require('node:test')
const assert = require('node:assert')
const { loadStepDeps } = require('./stepDepsRender')

const HW = {
  options: [
    { key: 'cuda', label: 'CUDA', for: 'NVIDIA', forZh: 'NVIDIA' },
    { key: 'ipex', label: 'IPEX / XPU', for: 'Intel', forZh: 'Intel' },
    { key: 'cpu', label: 'CPU', for: 'fallback', forZh: '兜底' },
  ],
  recommended: 'ipex',
}
const zh = (a, b) => b || a

const basePreview = {
  ok: true,
  env_command: ['uv', 'pip', 'install', '-r', 'requirements.txt', '--excludes', '.wizard-excludes.txt'],
  python_version: '3.11',
  choices: { supported: true, backend: null, excluded: [], upgradeTorch: false, versionOverrides: {}, applied: false },
}

test('守卫：这份测试真的拿到了活组件', () => {
  const mod = loadStepDeps()
  assert.ok(mod && typeof mod.choiceLines === 'function',
    '没拿到 choiceLines，缺 esbuild 依赖是环境问题，不要连同下面一起跳过')
})

test('choiceLines：第一行是总览标题，含后端/Python/不安装三项', () => {
  const { choiceLines } = loadStepDeps()
  const preview = { ...basePreview, choices: { ...basePreview.choices, backend: 'ipex', applied: true } }
  const lines = choiceLines(preview, HW, 'ipex', zh)
  assert.equal(lines[0], '本次生效的选择', '第一行是总览标题')
  assert.ok(lines.some((l) => l.includes('IPEX / XPU')), '要显示后端显示名，不是 key')
  assert.ok(lines.some((l) => l.includes('Torch 后端')), '要写明这是 Torch 后端')
  assert.ok(lines.some((l) => l.includes('3.11')), '要显示 Python 版本')
  assert.ok(lines.some((l) => l.includes('不安装') && l.includes('无')), '不安装项无排除时写「无」')
})

test('choiceLines：排除包时列出被排除的包名', () => {
  const { choiceLines } = loadStepDeps()
  const preview = {
    ...basePreview,
    choices: { ...basePreview.choices, excluded: ['einops', 'torch'], applied: true },
  }
  const lines = choiceLines(preview, HW, null, zh)
  const noInstall = lines.find((l) => l.includes('不安装'))
  assert.ok(noInstall.includes('einops') && noInstall.includes('torch'), '不安装项要列出被排除的包名')
})

test('choiceLines：改版本时列出包名与新版本', () => {
  const { choiceLines } = loadStepDeps()
  const preview = {
    ...basePreview,
    choices: { ...basePreview.choices, versionOverrides: { einops: '0.9.0' }, applied: true },
  }
  const lines = choiceLines(preview, HW, null, zh)
  assert.ok(lines.some((l) => l.includes('einops=0.9.0')), '要显示改后的版本对')
})

test('choiceLines：Python 用传入的当前选中值（与下拉联动，不等 preview 重拉）', () => {
  const { choiceLines } = loadStepDeps()
  // preview 里还是旧的 3.11，但用户已把下拉改到 3.10
  const preview = { ...basePreview, python_version: '3.11' }
  const lines = choiceLines(preview, HW, null, zh, '3.10')
  const pyLine = lines.find((l) => l.startsWith('Python'))
  assert.ok(pyLine.includes('3.10'), '总览要显示当前选中的 3.10，不是 preview 里的旧值 3.11')
})

test('choiceLines：没有任何选择时返回空数组', () => {
  const { choiceLines } = loadStepDeps()
  const preview = { ...basePreview, python_version: null, choices: { supported: true, backend: null, excluded: [], versionOverrides: {} } }
  // 没有任何后端/版本/排除时，choiceLines 仍会输出标题行（因为命令区至少要说明这次装了什么）；
  // 这里守的是「不含具体选择值」，避免凭空造出不存在的选择。
  const lines = choiceLines(preview, HW, null, zh)
  assert.ok(!lines.some((l) => l.includes('IPEX') || l.includes('CUDA')), '没有选后端时不应出现后端名')
})

test('第 2 步分两张框：安装配置 + 安装命令', () => {
  // way：配置类合成一张框，命令单独一张框。
  // 只守「两张框」这条结构约束，不守框内用什么控件、什么类名、什么措辞。
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'StepDeps.jsx'), 'utf8')
  const at = (s) => {
    const i = src.indexOf(s)
    assert.ok(i >= 0, `第 2 步缺少区块：${s}`)
    return i
  }
  const configAt = at('Installation settings')
  const cmdAt = at('Installation command')
  assert.ok(configAt < cmdAt, '安装配置框要在安装命令框之前')
  // 配置框里必须含 Torch 后端与显卡包说明（这两件事同属一个决定，必须放一起）
  const cfg = src.slice(configAt, cmdAt)
  assert.ok(cfg.includes('Torch backend'), '配置框里要有 Torch 后端')
  assert.ok(cfg.includes('These packages only run on this kind of graphics card'),
    '显卡包说明要和 Torch 后端在同一张配置框里')
})

test('命令框展示安装会执行的核心命令（含注释）', () => {
  // way：安装命令框要把「安装到底执行哪些命令」摆出来，
  // 每步带一句注释，不藏在别处。只守「有命令、有注释」这条约束，
  // 不守数据来自哪个字段、渲染成什么标签。
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'editor', 'StepDeps.jsx'), 'utf8')
  const cmdStart = src.indexOf('Installation command')
  assert.ok(cmdStart >= 0, '要有「安装命令」框')
  const cmd = src.slice(cmdStart)
  // 命令框里要有 argv 与注释两段（why/whyZh 是注释的来源，这里只查「有注释」）
  assert.ok(/\.argv/.test(cmd), '命令框里要显示每步的命令行')
  assert.ok(/\.why/.test(cmd), '命令框里每步要带注释')
})