// Guards for the four silent failures fixed in r12b-fix5.
//
// Every one of them degraded output quality without raising, so none of them
// can be caught by "does it run". Each check below was confirmed to FAIL
// against the pre-fix tree before being committed; a guard that has never
// been seen red is not a guard.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const CLEANER = 'engines/gpt-sovits/gsv_code/text/cleaner.py'
const TEXTPRE = 'engines/gpt-sovits/infer/TTS_infer_pack/TextPreprocessor.py'
const PREPROC = 'lib/training/steps/preprocess.js'
const BOOTSTRAP = 'tools/deploy/bootstrap.ps1'
const MDXNET = 'pipeline/uvr5/mdxnet.py'
const CHINESE2 = 'engines/gpt-sovits/gsv_code/text/chinese2.py'

test('short English runs are only padded when they are the whole line', () => {
  const src = read(CLEANER)
  assert.match(
    src,
    /def clean_text\(text, language, version=None, allow_short_pad=True\)/,
    'clean_text lost its allow_short_pad opt-out'
  )
  assert.match(
    src,
    /if allow_short_pad and len\(phones\) < 4:\n\s+phones = \[","\] \+ phones/,
    'the leading-comma pad is no longer guarded; every short English word in ' +
      'mixed text will be read with a pause in front of it'
  )
  // The pad must stay ON by default: training set preprocessing goes through
  // the same function, and phonemes have to match what the voice was trained on.
  assert.ok(
    !/allow_short_pad=False/.test(src),
    'cleaner.py must not change the default; the opt-out belongs at the call site'
  )
})

test('mixed-language runs opt out of the pad, single runs keep it', () => {
  const src = read(TEXTPRE)
  assert.match(
    src,
    /allow_short_pad=\(len\(textlist\) == 1\)/,
    'TextPreprocessor no longer tells clean_text whether this is a fragment'
  )
  assert.match(
    src,
    /clean_text\(text, language, version, allow_short_pad=allow_short_pad\)/,
    'clean_text_inf swallows allow_short_pad instead of passing it through'
  )
})

test('preprocess.js takes G2PWModel from PATHS and nowhere else', () => {
  const src = read(PREPROC)
  assert.match(
    src,
    /const g2pwModelDir = PATHS\.PRETRAINED\.g2pw/,
    'G2PWModel is being resolved locally again instead of through PATHS'
  )
  assert.ok(
    !/GPT_SoVITS'\s*,\s*'text'/.test(src),
    'the legacy sibling-directory fallback is back; it points outside the ' +
      'project and has not existed since r12b'
  )
  assert.ok(
    !/g2pwSelfContained/.test(src),
    'the gsv_code/text/G2PWModel candidate is back; that directory was emptied in r12b'
  )
})

// =============================================================================
//  以下几条守卫的对象在 2026-10-05 换了实现（install_torch.ps1 → tools/cli/install-torch.js），
//  但**它们守的知识一条都不能丢** —— 每一条都对应一次「不报错、只降质」的故障：
//
//   1. onnxruntime-gpu 不能从 PyPI 装 —— 那个 wheel 到 1.18.x 为止是 CUDA 11.8 构建，
//      它的 provider DLL 在 torch cu121 旁边**载不进去且不抛错**，onnxruntime 只是
//      悄悄丢掉 CUDA ExecutionProvider，MDX-Net / g2pW 于是永远跑在 CPU 上。
//      ⭐ 版本 pin 从来不够 —— **index 也是 pin 的一部分**。
//   2. 必须 `--index-url`，不能 `--extra-index-url` —— extra index 让 pip 在 ADO 的
//      feed 和 PyPI 之间**挑**，而 PyPI 上有个同名同版本的 wheel（就是上面那个坏的）。
//   3. 验证必须**真的把 provider 的 DLL 载一遍**。
//      `get_available_providers()` ��算验证：onnxruntime<1.19 会按构建配置列出
//      CUDAExecutionProvider，不管那些 DLL 能不能载入 —— 旧探针因此在 CUDA EP
//      从未初始化过的机器上报过成功。
//
//  另外两条随实现一起消失了，这里如实记录而不是留下空壳：
//   · 「bootstrap 的 inline 回退必须用同一个 feed」—— 那段回退**已被删除**。
//     主体成为单点之后，「文件缺失」意味着安装包不完整，不是运行时该兜的情况；
//     兜它的代价就是第二份 torch/onnxruntime 安装逻辑，而那份装的是上面那个
//     坏 wheel。见 tools/deploy/bootstrap.ps1 第 4 步的说明。
//   · 「共享 DLL 注册块在每份副本里必须一致」—— 副本本身没有了。
//     现在该守的是：**别让第二份实现重新长出来**，见下一条。
// =============================================================================

const TORCH_BODY = 'tools/cli/install-torch.js'

test('onnxruntime-gpu 不从 PyPI 装（它是 CUDA 11.8 的，provider 载不进去）', () => {
  const src = read(TORCH_BODY)
  assert.match(
    src,
    /onnxruntime-cuda-12\/pypi\/simple/,
    'onnxruntime-gpu is being installed from PyPI again. Before 1.19.0 that ' +
      'wheel targets CUDA 11.8 and its CUDA provider cannot load against torch cu121.'
  )
  assert.match(src, /--index-url/, 'the index arguments are no longer passed to the installer')
})

test('喂给安装器的是 --index-url 而不是 --extra-index-url', () => {
  const src = read(TORCH_BODY)
  assert.match(src, /ortIndexArgs/, 'the ort index args are gone')
  assert.ok(
    !/ortIndexArgs[^\n]*--extra-index-url/.test(src) &&
    !/extra-index-url[^\n]*ORT_GPU_INDEX/.test(src),
    'an extra index lets the installer choose between the ADO feed and PyPI, ' +
      'and PyPI carries a wheel with the same name and version; it must be --index-url'
  )
})

test('onnxruntime 的检查真去载 provider 的 DLL，而不是问一个列表', () => {
  const src = read(TORCH_BODY)
  // ⚠️ 必须带 `ort.` 前缀 —— 那才是真实的调用形态（ort.get_available_providers()）。
  //   ⛔ 我第一版抄成裸词 get_available_providers()，结果：① 撞上主体里**解释这件事的
  //   注释**（那段注释就是在说「这个函数不算验证」）② 判据反而放松了 ——
  //   裸词连注释一起禁，而注释恰恰该留着。
  assert.ok(
    !/ort\.get_available_providers\(\)/.test(src),
    'ort.get_available_providers() is back. On onnxruntime<1.19 it lists CUDA from ' +
      'the build config even when the DLLs cannot load, so this check can never fail.'
  )
  // ⭐ 跨平台的一处：原来只有 ctypes.WinDLL（Windows 专用），Linux 上会 AttributeError。
  assert.match(src, /ctypes\.WinDLL/, 'the probe no longer loads the provider DLL')
  assert.match(src, /ctypes\.CDLL/, 'the probe lost its non-Windows path')
  assert.match(src, /CUDA_EP: OK/, 'the probe no longer emits the token the script greps for')
})

test('torch/onnxruntime 的安装逻辑只有一份（防第二份实现重新长出来）', () => {
  // ⛔ 不是「查文本里有没有某句话」—— 是**真的查磁盘上有几个实现**。
  const gone = [
    'tools/deploy/install_torch.ps1',   // 原 PowerShell 主体
    'tools/deploy/install_pytorch.bat', // 同一件事的第二个入口名
  ]
  for (const rel of gone) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)),
      `${rel} 又出现了。主体在 tools/cli/install-torch.js，薄壳是`
      + ' install-torch.bat / install-torch.sh。留第二份实现 = 迟早行为不一致。')
  }
  // ⭐ 反向：薄壳必须在，且都指向主体
  for (const rel of ['tools/deploy/install-torch.bat', 'tools/deploy/install-torch.sh']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `薄壳 ${rel} 不见了`)
    assert.match(read(rel), /install-torch\.js/, `${rel} 没有指向主体`)
  }
})
