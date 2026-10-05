// =============================================================================
//  install-torch.node.test.js — install-torch.js 的决策逻辑守卫
//
//  ⚠️ 这条脚本要做的是「选一个构建」，而**选错的后果是静默的**：装出一个
//     永远用不上的 2.5 GB，或者在本机跑不动的构建。所以决策必须被测。
//
//  ⭐ 测法：**真的跑它**，读它打印的决策行 —— 不重新实现一遍决策。
//     （重新实现一遍 = 两份逻辑 = 测的是那份副本，不是真脚本。）
//     主体需要 --dry-run 才不下载 2.5 GB；它也正是为此才有的。
// =============================================================================

'use strict'

const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const BODY = path.join(ROOT, 'tools', 'cli', 'install-torch.js')

// 主体会 require lib/engines/platformPaths.js 和 lib/system/gpu.js，
// 而它第一件事就是找 venv 解释器 —— 那个不存在就直接退出。
// ⇒ 传一个**确实存在**的解释器路径，用平台根 venv（本仓库有）。
function venvPython () {
  const isWin = process.platform === 'win32'
  const p = path.join(ROOT, 'venv', isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python')
  assert.ok(fs.existsSync(p), '这个仓库应该有根 venv；没有的话本组测试无法运行（用 --python 绕）')
  return p
}

/** 跑一次主体，返回 {rc, out} */
function run (args, env) {
  const r = spawnSync(process.execPath, [BODY, '--python', venvPython(), '--dry-run']
    .concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { NO_COLOR: '1' }, env || {}),
  })
  assert.equal(r.status, 0, '--dry-run 不该失败：\n' + r.stdout + r.stderr)
  return (r.stdout || '') + (r.stderr || '')
}

/** 从 --dry-run 的输出里取某个字段 */
function field (out, name) {
  const m = new RegExp('^\\s+' + name + '\\s+(.*)$', 'm').exec(out)
  return m ? m[1].trim() : null
}

// ── 1. 四个显式 backend 各自解析到正确的 index ────────────────────────────────
test('显式指定 backend ⇒ 解析到正确的 index', () => {
  const cases = [
    ['cpu', 'cpu'],   // PyTorch 官方 CPU 构建
    ['xpu', 'xpu'],   // PyTorch 官方 Intel XPU 构建
    ['cuda', 'cu121'], // 默认 cu121（原 .ps1 的默认值）
    ['rocm', 'rocm6.1'], // ⭐ 注意：ROCm 的 index 是 rocm<ver>，不是 rocm<cuda>
  ]
  for (const [backend, wantSuffix] of cases) {
    const out = run(['--backend', backend])
    const index = field(out, 'index')
    assert.ok(index, backend + ' 没解析出 index')
    assert.ok(index.endsWith(wantSuffix),
      backend + ' 的 index 应以 ' + wantSuffix + ' 结尾，实际 ' + index)
    assert.match(index, /^https:\/\/download\.pytorch\.org\/whl\//,
      backend + ' 的 index 必须来自 PyTorch 官方源，实际 ' + index)
  }
})

// ── 2. ⭐ ROCm 的 index 不能写成 rocmcu121（原 .ps1 没有这个分支，
//       如果照抄 CUDA 那套拼法就会去请求一个不存在的 rocmcu121 源）──
test('ROCm 的 index 不是把 CUDA 那套拼法照抄', () => {
  const out = run(['--backend', 'rocm'])
  const index = field(out, 'index')
  assert.ok(!/rocmcu/.test(index), 'ROCm index 出现 "rocmcu" ⇒ 把 CUDA 的拼法照抄了：' + index)
  assert.ok(/rocm\d/.test(index), 'ROCm index 应带版本号（rocm6.1 之类）：' + index)
})

// ── 3. --cuda 显式参数必须真的改 index（第一版漏了这条，
//       于是 TTS_TORCH_CUDA=cu118 却仍从 cu121 装）────────────────────────
test('--cuda 与 TTS_TORCH_CUDA 都真的改 index', () => {
  assert.match(field(run(['--backend', 'cuda', '--cuda', 'cu118']), 'index'), /cu118$/,
    '--cuda cu118 被忽略了')
  assert.match(field(run([], { TTS_TORCH_CUDA: 'cu126' }), 'index'), /cu126$/,
    'TTS_TORCH_CUDA=cu126 被忽略了 —— 设了环境变量却拿到别的构建，比不认它更糟')
})

// ── 4. onnxruntime 的 GPU/CPU 拆分：只有 CUDA 用 GPU wheel ────────────────
//       ⚠️ 这一点很容易被写错：Intel XPU / AMD ROCm 下**仍然**是 CPU 版
//       onnxruntime，因为 onnxruntime-gpu 只认 CUDA ExecutionProvider。
test('onnxruntime 只有在 CUDA 下才装 GPU wheel', () => {
  assert.match(field(run(['--backend', 'cuda']), 'onnx'), /^onnxruntime-gpu==/,
    'CUDA 下应装 onnxruntime-gpu')
  for (const b of ['cpu', 'xpu', 'rocm']) {
    const ort = field(run(['--backend', b]), 'onnx')
    assert.match(ort, /^onnxruntime==/,
      b + ' 下应是 CPU 版 onnxruntime（onnxruntime-gpu 只认 CUDA EP），实际 ' + ort)
  }
})

// ── 5. 自动探测在**本机**必须给出自洽的结果 ──────────────────────────────────
//       ⛔ 不写死「应选 xpu」—— 那是这台机器的事实，换台机器就假绿。
//       只断言「探测到的设备与选出的 backend 自洽」。
test('自动探测的结论与本机设备自洽', () => {
  const out = run([])
  const devices = /本机计算设备：(.+)/.exec(out)
  assert.ok(devices, '自动探测应当报告本机设备，实际输出：\n' + out)
  const backend = /选定构建：(\w+)/.exec(out)
  assert.ok(backend, '自动探测应当报告选定构建')
  const picked = backend[1].toLowerCase()

  const name = devices[1]
  // vendor 关键词 ⇔ backend 必须对应上；「探测不到」时只能是 cpu
  if (/nvidia/i.test(name)) assert.equal(picked, 'cuda', '有 NVIDIA 却选了 ' + picked)
  else if (/arc|intel|iris|xe/i.test(name)) assert.equal(picked, 'xpu', '有 Intel 却选了 ' + picked)
  else if (/amd|radeon/i.test(name)) {
    // Windows 上官方没有 ROCm wheel ⇒ 只能是 cpu（脚本会说明原因）
    const allowed = process.platform === 'win32' ? ['cpu'] : ['rocm', 'cpu']
    assert.ok(allowed.includes(picked), '有 AMD 却选了 ' + picked)
  } else {
    assert.equal(picked, 'cpu', '探测不到设备时只能落 CPU，实际 ' + picked)
  }
})

// ── 6. ⭐ 两个薄壳必须调同一份主体（否则 Windows 与 macOS 会行为分叉）────────
test('薄壳 .bat 与 .sh 都调同一份 Node 主体，且不含逻辑', () => {
  const bat = fs.readFileSync(path.join(ROOT, 'tools', 'deploy', 'install-torch.bat'), 'utf8')
  const sh = fs.readFileSync(path.join(ROOT, 'tools', 'deploy', 'install-torch.sh'), 'utf8')

  for (const [name, src] of [['bat', bat], ['sh', sh]]) {
    assert.match(src, /install-torch\.js/,
      name + ' 薄壳必须调 Node 主体')
    // ⛔ 薄壳里不许出现选构建的关键词 —— 那是主体的职责，
    //   两边各有一份就一定会分叉。
    assert.ok(!/whl\/(cpu|xpu|cuda|rocm)/.test(src),
      name + ' 薄壳里出现了 index ⇒ 选构建的逻辑漏到薄壳里了')
    assert.ok(!/nvidia-smi|Win32_VideoController|system_profiler/.test(src),
      name + ' 薄壳里出现了设备探测 ⇒ 探测逻辑漏到薄壳里了')
  }
})

// ── 7. ⚠️ .bat 必须是纯 ASCII（实测踩过的坑，写成守卫免得有人加回中文）────
test('install-torch.bat 是纯 ASCII', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'tools', 'deploy', 'install-torch.bat'))
  const bad = [...buf].filter(b => b > 127)
  assert.equal(bad.length, 0,
    `批处理里有 ${bad.length} 个非 ASCII 字节。cmd.exe 按系统 OEM 代码页（本机 GBK）`
    + '读 .bat，而本文件是 UTF-8 ⇒ GBK 解码会把行尾 0x0A 当成双字节字符的后半截'
    + '吃掉，换行错位，cmd 于是把注释碎片当命令执行。'
    + 'chcp 65001 救不了（只影响它之后的行）。中文请放 Node 主体。')
})

// ── 8. 旧 .ps1 必须已被替换掉（防「两份实现」漂移）─────────────────────────
test('旧的 install_torch.ps1 已不存在（否则会漂移出第二份实现）', () => {
  const p = path.join(ROOT, 'tools', 'deploy', 'install_torch.ps1')
  assert.ok(!fs.existsSync(p),
    'tools/deploy/install_torch.ps1 还在。'
    + '主体已移到 tools/cli/install-torch.js；留着旧脚本 = 两份实现 = 迟早行为不一致。'
    + '（若只是要保留兼容入口，让它转发到 Node，不要留逻辑。）')
})