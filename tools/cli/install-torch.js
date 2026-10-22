// 把 PyTorch 与 onnxruntime 装进一个 venv（跨平台主体）。
// torch 与 onnxruntime 都不在 requirements-gpt-sovits.txt 里：wheel 巨大、构建目标跟本机的
// 计算设备绑定、且走独立 index。写进那份锁，就等于把「本机有什么」变成「所有机器有什么」。
// torch 属于引擎层不属于平台层，但本脚本的默认目标仍是平台根 venv；
// 要装到引擎的 venv，用 --python 显式指定解释器。
//
// 用法：node tools/cli/install-torch.js [--backend cpu|cuda|xpu|rocm] [--cuda cu121]
//       [--rocm 6.1] [--python <venv 解释器>] [--dry-run]
// 薄壳 install-torch.bat / install-torch.sh 调的就是这个。
// 环境变量（仅在没给 --backend 时生效）：TTS_TORCH_CPU=1、TTS_TORCH_BACKEND、
//       TTS_TORCH_CUDA、TTS_NO_UV=1（跳过 uv，用 pip）。
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const { venvPython } = require(path.join(ROOT, 'lib', 'engines', 'platformPaths.js'))
const gpu = require(path.join(ROOT, 'lib', 'system', 'gpu.js'))

// 日志一律带 [torch] 前缀，沿用既有脚本的习惯。
const C = { cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' }
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (c, m) => (useColor ? c + m + C.off : m)
const Info = m => console.log(paint(C.cyan, '[torch] ' + m))
const Ok = m => console.log(paint(C.green, '[torch] ' + m))
const Warn = m => console.log(paint(C.yellow, '[torch] ' + m))
const Die = m => { console.error(paint(C.red, '[torch][ERROR] ' + m)); process.exit(1) }

// 参数解析
const argv = process.argv.slice(2)
function flag (name) { return argv.includes(name) }
function opt (name, dflt) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

const VER = {
  torch: opt('--torch', '2.2.0'),
  audio: opt('--audio', '2.2.0'),
  vision: opt('--vision', '0.17.0'),
  ort: opt('--ort', '1.18.0'),
  cuda: opt('--cuda', 'cu121'),
  // ROCm 用的是 ROCm 版本（6.1 / 6.2 / …），跟 CUDA 是两套编号：
  // 不能拿 cu121 去掉 "cu" 当 ROCm 版本，那样会指向一个不存在的源。
  rocm: opt('--rocm', '6.1'),
}
const DRY = flag('--dry-run')
const WITH_DEPS = flag('--with-deps')

// 硬编码 `venv\Scripts\python.exe` 是 Windows 布局；macOS/Linux 的 venv 是
// `venv/bin/python`（无 .exe、无 Scripts）。用 platformPaths 推导。
// venvPython 返回 {ok, python} 或 {ok:false, why}，不是字符串：
// 它对 FreeBSD 之类故意不猜，而是给一句用户能看懂的话。
const explicitPy = opt('--python', null)
let PY = null
if (explicitPy) {
  PY = path.resolve(explicitPy)
} else {
  const r = venvPython(path.join(ROOT, 'venv'), process.platform)
  if (!r.ok) Die(r.why)
  PY = r.python
}

if (!fs.existsSync(PY)) {
  Die('venv 解释器不存在：' + PY +
      '\n        先跑部署（它负责建 venv），再回来跑这个。')
}
if (!explicitPy) {
  Warn('默认目标仍是**平台根 venv**（既有行为）。')
  Warn('  但 torch 属于**引擎层**：接更多引擎后应当用 --python 指向那台引擎的 venv。')
}

// 问操作系统「有什么计算设备」，并按 vendor 选构建（lib/system/gpu.js）。
// 检测失败落 CPU：CPU 构建是那个「到处都能 import」的选择，
// 而 GPU 构建猜错会装出一个在本机永远用不上的大 wheel。
const BACKEND_LABEL = { cuda: 'CUDA (NVIDIA)', xpu: 'XPU (Intel)', cpu: 'CPU', rocm: 'ROCm (AMD)' }

function decideBackend () {
  const forced = opt('--backend', null) || process.env.TTS_TORCH_BACKEND || null
  if (forced) {
    const b = String(forced).toLowerCase()
    if (!BACKEND_LABEL[b]) Die('未知 backend：' + forced + '（可选：' + Object.keys(BACKEND_LABEL).join(' / ') + '）')
    Info('显式指定 backend = ' + b + '（' + BACKEND_LABEL[b] + '）')
    return { backend: b, reason: '命令行 / 环境变量显式指定', gpus: [] }
  }
  if (process.env.TTS_TORCH_CPU === '1') {
    Info('TTS_TORCH_CPU=1 -> 强制 CPU 构建。')
    return { backend: 'cpu', reason: 'TTS_TORCH_CPU=1', gpus: [] }
  }
  if (process.env.TTS_TORCH_CUDA) {
    // 必须把 VER.cuda 一起改掉：否则设了 cu118 却仍从 cu121 的 index 装。
    // 用户设环境变量却拿到别的构建，比不认这个变量更糟。
    VER.cuda = process.env.TTS_TORCH_CUDA
    Info('TTS_TORCH_CUDA=' + VER.cuda + ' -> 强制 CUDA 构建。')
    return { backend: 'cuda', reason: 'TTS_TORCH_CUDA', devices: [] }
  }

  // 自动探测：问操作系统。detectGpuNow() 返回的是一个对象不是数组：
  //   {ready, available, device_name, vendor, devices:[{name,vendor}], platform, probe}
  // `available` 的含义是「有没有 CUDA」，别拿它当「有没有 GPU」用。要问的是 vendor。
  let info = null
  try { info = gpu.detectGpuNow() } catch (e) { info = null }
  const devices = (info && Array.isArray(info.devices) && info.devices.length)
    ? info.devices
    : (info && info.vendor ? [{ name: info.device_name || '?', vendor: info.vendor }] : [])
  const has = v => devices.some(d => d.vendor === v)

  Info('本机计算设备：' + (devices.length
    ? devices.map(d => d.name + '（' + (d.vendor || '?') + '）').join('；')
    : '探测不到任何计算设备'))

  // 优先级：NVIDIA > Intel > AMD > Apple。NVIDIA 优先：多卡机器上 iGPU 与 dGPU
  // 常同时存在，而 torch 的 CUDA 构建在这类机器上才是真正跑得动的那个。
  if (has('nvidia')) {
    return { backend: 'cuda', reason: '本机有 NVIDIA 设备', devices }
  }
  if (has('intel')) {
    // Intel 核显与独显走 XPU 构建，index 是 pytorch 官方给的。
    return { backend: 'xpu', reason: '本机有 Intel 设备（无 NVIDIA）', devices }
  }
  if (has('amd')) {
    // AMD 走 ROCm。PyTorch 官方的 ROCm wheel 只发 Linux，Windows 上没有：
    // 与其装一个跑不起来的，不如说明清楚。
    if (process.platform === 'win32') {
      Warn('本机有 AMD 设备，但 PyTorch 官方 ROCm wheel **不发布 Windows 版**。')
      Warn('  ⇒ 落到 CPU 构建。若要用 AMD：装 Linux，或改用 DirectML 版 torch。')
      return { backend: 'cpu', reason: 'AMD 设备，但 Windows 无 ROCm wheel', devices }
    }
    return { backend: 'rocm', reason: '本机有 AMD 设备', devices }
  }
  if (has('apple')) {
    // Apple Silicon：官方没有 MPS 专用构建，走 CPU 构建但用 MPS 后端。
    Info('本机是 Apple 设备。PyTorch 无 MPS 专用 wheel：装 CPU 构建，'
       + 'PyTorch 会自动用 MPS 后端（不需 CUDA/ROCm）。')
    return { backend: 'cpu', reason: 'Apple 设备（走 CPU 构建 + MPS 后端）', devices }
  }
  Warn('探测不到可用的 GPU 构建目标 -> 落到 CPU 构建。')
  Warn('（CPU 构建是「到处都能 import」的那一个；GPU 构建猜错会装出 2.5 GB 用不上的东西。）')
  return { backend: 'cpu', reason: '探测不到 GPU', devices }
}

const decision = decideBackend()

// index 与包清单
const TORCH_INDEX = {
  cpu: 'https://download.pytorch.org/whl/cpu',
  xpu: 'https://download.pytorch.org/whl/xpu',
  cuda: 'https://download.pytorch.org/whl/' + VER.cuda,
  rocm: 'https://download.pytorch.org/whl/rocm' + VER.rocm,
}
const index = TORCH_INDEX[decision.backend]

// onnxruntime 的 CPU 与 GPU 拆分：它只有 CUDA 与 CPU 两种 wheel，所以 Intel XPU 与
// AMD ROCm 下仍然装 CPU 版 onnxruntime。那不是缺陷：onnxruntime-gpu 只认
// CUDA ExecutionProvider。影响面要说清楚：MDX-Net 分离人声、g2pW 多音字消歧会走 CPU。
const ortPkg = decision.backend === 'cuda'
  ? 'onnxruntime-gpu==' + VER.ort
  : 'onnxruntime==' + VER.ort
const ortIsGpuWheel = decision.backend === 'cuda'

Info('选定构建：' + BACKEND_LABEL[decision.backend] + '（依据：' + decision.reason + '）')
Info('index：' + index)
if (decision.backend === 'cpu') {
  Warn('CPU 构建：PyTorch 只在 CPU 上跑。')
  Warn('  * 推理（语音生成）可用，只是比 GPU 慢。')
  Warn('  * 微调 / 训练在 CPU 上慢 10-100 倍，一般不可行。')
}

const pkgs = ['torch==' + VER.torch, 'torchaudio==' + VER.audio, 'torchvision==' + VER.vision]

if (DRY) {
  console.log(paint(C.dim, '\n[torch] --dry-run：不安装。以下是实际会执行的内容：\n'))
  console.log('  解释器  ' + PY)
  console.log('  backend ' + decision.backend + '  （' + decision.reason + '）')
  console.log('  index   ' + index)
  console.log('  包      ' + pkgs.join('  '))
  console.log('  依赖    ' + (WITH_DEPS ? '带依赖安装（会改动锁定的版本）' : '--no-deps（保护锁定的版本）'))
  console.log('  onnx    ' + ortPkg + (ortIsGpuWheel ? '（来自 Azure DevOps feed，非 PyPI）' : ''))
  console.log(paint(C.dim, '\n[torch] 去掉 --dry-run 即真正安装。\n'))
  process.exit(0)
}

// torch 默认 --no-deps：它声明的依赖（fsspec / sympy / networkx 等）都已被
// requirements-gpt-sovits.txt 锁定并装好。让 pip 或 uv 去解析 torch 的依赖，
// 它会按 torch 的版本区间把锁定的版本升掉或降掉，静悄悄破坏冻结环境。
// 逃生口是 --with-deps（裸 venv 场景）。
const depFlag = WITH_DEPS ? [] : ['--no-deps']
if (!WITH_DEPS) Info('装 torch 时带 --no-deps（保护 requirements-gpt-sovits.txt 里锁定的版本）。')
else Warn('--with-deps：会连依赖一起装，可能改动已锁定的版本。')

const env = Object.assign({}, process.env, {
  UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT || '120',
  UV_LINK_MODE: 'copy',
})

// 优先 uv（并行下载），失败自动退回 pip。
let useUv = process.env.TTS_NO_UV !== '1' && spawnSync(PY, ['-m', 'uv', '--version'], { env, stdio: 'ignore' }).status === 0
if (process.env.TTS_NO_UV === '1') Warn('TTS_NO_UV=1：跳过 uv，用 pip。')

function runNative (exe, args) {
  // stdio: 'inherit'：让进度条直接进终端，不经过管道。
  return spawnSync(exe, args, { env, stdio: 'inherit' }).status
}

function install (pkgsToInstall, extraArgs) {
  if (useUv) {
    Info('用 uv 并行下载 …')
    const args = ['-m', 'uv', 'pip', 'install', '--python', PY]
      .concat(depFlag, extraArgs, pkgsToInstall,
        // 让 uv 像 pip 一样同时看所有 index，否则它会从 PyPI 拿 CPU 构建，
        // 而不是从 CUDA/XPU index 拿带后端的那个。
        ['--extra-index-url', index, '--index-strategy', 'unsafe-best-match'])
    if (runNative(PY, args) === 0) return true
    // 记住 uv 已经坏了：后面的包不再浪费一次 uv 尝试。
    useUv = false
    Warn('uv 安装失败；退回 pip（兼容性最好的一条路）…')
  }
  Info('用 pip 安装 …')
  return runNative(PY, ['-m', 'pip', 'install']
    .concat(depFlag, extraArgs, pkgsToInstall, ['--extra-index-url', index])) === 0
}

if (!install(pkgs, [])) Die('torch 安装失败。检查网络 / 所选构建，然后重跑。')

// 不把多词字符串塞进 `python -c`：Windows PowerShell 5.1 会把原生参数按空格
// 重解析并吃掉内层引号，于是 python 只收到不完整的代码。
// 这里落一个临时文件再跑，跨平台且不依赖 shell 的引号规则。
function runProbe (src) {
  const tmp = path.join(os.tmpdir(), 'ttsbroker_probe_' + process.pid + '_' + Math.abs(hashCode(src)) + '.py')
  fs.writeFileSync(tmp, src, 'utf8')
  try {
    const r = spawnSync(PY, ['-u', tmp], { encoding: 'utf8' })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') }
  } finally {
    try { fs.unlinkSync(tmp) } catch (_) {}
  }
}
function hashCode (s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return h }

const torchProbe = runProbe(`
import torch
print("  torch", torch.__version__)
for name, mod in (("cuda", "cuda"), ("xpu", "xpu")):
    try:
        m = getattr(torch, mod, None)
        print("  %s_available = %s" % (name, bool(m and m.is_available())))
    except Exception as ex:
        print("  %s_available = False (%s)" % (name, type(ex).__name__))
`)
if (torchProbe.rc !== 0) {
  Warn('torch 装上了，但导入/验证失败（见上面输出）。')
  if (!WITH_DEPS) {
    Warn('若报的是缺模块（sympy / networkx / fsspec 之类），通常是在裸 venv 上运行。')
    Warn('请先完成完整部署，或加 --with-deps。')
  }
} else {
  Ok('PyTorch 就绪。')
}

// 两个 onnxruntime 包提供同一个 `onnxruntime` import，共存会打架：
// 先卸掉两个，重跑（换机器搬 venv、CPU 与 GPU 切换）最后只剩一种。
Info('保证只留一种 onnxruntime 变体（先卸掉可能冲突的那个）。')
spawnSync(PY, ['-m', 'pip', 'uninstall', '-y', 'onnxruntime', 'onnxruntime-gpu'], { env, stdio: 'ignore' })

// onnxruntime-gpu 不能从 PyPI 拿：PyPI 上那个是按 CUDA 11.8 构建的，
// 会 import cudart64_110 / cublas64_11，而 torch cu121 带的是 cudart64_12，
// 于是 Windows 报 error 126，onnxruntime 不报错地丢掉 CUDA ExecutionProvider，
// MDX-Net 和 g2pW 就永远跑在 CPU 上，日志里什么都没有。
// CUDA 12 构建只在 ONNX Runtime 的 Azure DevOps feed 上。
// 版本 pin 从来不够：index 也是 pin 的一部分。
const ORT_GPU_INDEX = 'https://aiinfra.pkgs.visualstudio.com/PublicPackages/_packaging/onnxruntime-cuda-12/pypi/simple/'
const ortIndexArgs = ortIsGpuWheel ? ['--index-url', ORT_GPU_INDEX] : []
if (ortIsGpuWheel) Info('onnxruntime GPU wheel 来源：' + ORT_GPU_INDEX)

if (!install([ortPkg], ortIndexArgs)) Die('onnxruntime 安装失败。检查网络后重跑。')

// 验证 onnxruntime：GPU 时真的把 provider 的 DLL 载一遍。
// get_available_providers() 不算验证：onnxruntime 会按构建配置列出
// CUDAExecutionProvider，不管那些 DLL 能不能载入。真的去载 DLL：那正是
// error 126 会发生的操作，而且安装期不需要有 .onnx 文件。
const ortProbe = runProbe(`
import ctypes, os, sys
is_win = sys.platform.startswith('win')

# CUDA/cuDNN 的 DLL 在 torch 包里；Windows 上 Python 3.8+ **只**通过
# add_dll_directory 找它们，不看 %PATH%
try:
    import torch
    lib = os.path.join(os.path.dirname(torch.__file__), "lib")
    if is_win and os.path.isdir(lib):
        os.add_dll_directory(lib)
except Exception as ex:
    print("  torch 不可导入（%r）：GPU 检查会不确定" % (ex,))

import onnxruntime as ort
print("  onnxruntime", ort.__version__)
capi = os.path.join(os.path.dirname(ort.__file__), "capi")
if is_win and os.path.isdir(capi):
    try: os.add_dll_directory(capi)
    except Exception: pass

# 跨平台的一处：原来只有 ctypes.WinDLL（Windows 专用）
name = "onnxruntime_providers_cuda.dll" if is_win else "libonnxruntime_providers_cuda.so"
dll = os.path.join(capi, name)
if not os.path.isfile(dll):
    print("  CUDA_EP: ABSENT（这是 CPU-only wheel）")
else:
    try:
        (ctypes.WinDLL if is_win else ctypes.CDLL)(dll)
        print("  CUDA_EP: OK")
    except OSError as ex:
        print("  CUDA_EP: FAILED %s" % (ex,))
        print("  CUDA_EP: 缺的是**依赖**，不是这个文件本身。")
`)
if (ortProbe.rc !== 0) {
  Warn('onnxruntime 装上了，但导入/验证失败（见上面输出）。')
} else if (ortIsGpuWheel && !/CUDA_EP: OK/.test(ortProbe.out)) {
  Warn('onnxruntime-gpu 已安装，但其 CUDA ExecutionProvider **无法加载**：')
  Warn('所有用 onnxruntime 的地方（MDX-Net 分离人声、g2pW 多音字消歧）会跑在 CPU 上，**且不报错**。')
  Warn('通常是该 wheel 的 CUDA 主版本与 torch 不匹配。')
} else {
  Ok('onnxruntime 就绪。')
}

if (decision.backend === 'cpu') {
  console.log('')
  for (const line of [
    '====================================================================',
    '  CPU 构建已启用  --  没有用上 GPU',
    '',
    '    推理 / 语音生成   : 可用（比 GPU 慢）',
    '    微调 / 训练       : 慢 10-100 倍，一般不可行',
    '',
    '  本机有可用的 GPU 但没被认出来？显式指定后重跑：',
    '      node tools/cli/install-torch.js --backend cuda   （NVIDIA）',
    '      node tools/cli/install-torch.js --backend xpu    （Intel）',
    '      node tools/cli/install-torch.js --backend rocm   （AMD/Linux，可加 --rocm 6.2）',
    '====================================================================',
  ]) console.log(paint(C.yellow, '[torch] ' + line))
} else {
  console.log('')
  Ok('构建：' + BACKEND_LABEL[decision.backend] + '。'
     + (decision.backend === 'cuda' ? '' : '⚠️ onnxruntime 仍是 CPU 构建：它只认 CUDA ExecutionProvider。'))
}