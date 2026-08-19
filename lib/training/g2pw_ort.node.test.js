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

const CLEANER = 'vendor/tts/gpt-sovits/gsv_code/text/cleaner.py'
const TEXTPRE = 'vendor/tts/gpt-sovits/infer/TTS_infer_pack/TextPreprocessor.py'
const PREPROC = 'lib/training/steps/preprocess.js'
const INSTALL = 'tools/deploy/install_torch.ps1'
const BOOTSTRAP = 'tools/deploy/bootstrap.ps1'
const MDXNET = 'vendor/uvr5/mdxnet.py'
const CHINESE2 = 'vendor/tts/gpt-sovits/gsv_code/text/chinese2.py'

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

test('the GPU onnxruntime wheel is pinned to an index, not just a version', () => {
  const src = read(INSTALL)
  assert.match(
    src,
    /onnxruntime-cuda-12\/pypi\/simple/,
    'onnxruntime-gpu is being installed from PyPI again. Before 1.19.0 that ' +
      'wheel targets CUDA 11.8 and its CUDA provider cannot load against torch cu121.'
  )
  assert.match(src, /\$ortIndexArgs/, 'the index arguments are no longer passed to the installer')
})

// bootstrap.ps1 normally delegates to install_torch.ps1, but it carries an inline
// last-resort branch for the case where that file is missing. That branch was
// still running the plain `pip install onnxruntime-gpu==1.18.0`, i.e. the exact
// command the fix above exists to prevent -- and because the failure is silent,
// a machine bootstrapped through the fallback would look fine forever.
test('the bootstrap fallback installs the GPU wheel from the same index', () => {
  const src = read(BOOTSTRAP)
  assert.match(
    src,
    /onnxruntime-cuda-12\/pypi\/simple/,
    'the inline fallback in bootstrap.ps1 installs onnxruntime-gpu from PyPI, ' +
      'which before 1.19.0 targets CUDA 11.8 and cannot load against torch cu121'
  )
  assert.match(
    src,
    /'--index-url',\$ORT_CUDA12_INDEX,\$ORT_GPU_VER/,
    'the index is declared but not passed to the install command'
  )
  assert.ok(
    !/'--extra-index-url',\$ORT_CUDA12_INDEX/.test(src),
    'an extra index lets pip choose between the ADO feed and PyPI, and PyPI ' +
      'carries a wheel with the same name and version; it must be --index-url'
  )
  // The two files must agree on the feed, or a fallback bootstrap installs a
  // different wheel than a normal one.
  const feed = /(https:\/\/aiinfra\.pkgs\.visualstudio\.com\/\S*?simple\/)/
  const a = read(INSTALL).match(feed)
  const b = src.match(feed)
  assert.ok(a && b, 'one of the two scripts no longer declares the feed URL')
  assert.strictEqual(a[1], b[1], 'install_torch.ps1 and bootstrap.ps1 point at different feeds')
})

test('the onnxruntime check loads the provider DLL instead of asking a list', () => {
  const src = read(INSTALL)
  assert.ok(
    !/ort\.get_available_providers\(\)/.test(src),
    'get_available_providers() is back. On onnxruntime<1.19 it lists CUDA from ' +
      'the build config even when the DLLs cannot load, so this check can never fail.'
  )
  assert.match(src, /ctypes\.WinDLL\(dll\)/, 'the probe no longer actually loads the provider DLL')
  assert.match(src, /CUDA_EP: OK/, 'the probe no longer emits the token the script greps for')
  assert.match(src, /\$ortOut -match 'CUDA_EP: OK'/, 'the verdict is not reading the probe result')
})

test('the CUDA DLL registration block is identical in every copy', () => {
  const BEGIN = '# --- BEGIN shared block: onnxruntime CUDA DLL registration'
  const END = '# --- END shared block: onnxruntime CUDA DLL registration'
  const extract = (rel) => {
    const src = read(rel)
    const i = src.indexOf(BEGIN)
    const j = src.indexOf(END)
    assert.ok(i !== -1 && j > i, `${rel} no longer contains the shared block`)
    return src.slice(i, src.indexOf('\n', j) === -1 ? undefined : src.indexOf('\n', j))
  }
  const a = extract(MDXNET)
  const b = extract(CHINESE2)
  assert.strictEqual(
    a,
    b,
    'the two copies have drifted. They are duplicated on purpose (the two ' +
      'vendor trees run in separate processes and cannot import each other), ' +
      'so this equality is the only thing keeping them in sync.'
  )
  assert.match(a, /os\.add_dll_directory\(lib\)/, 'the block no longer registers anything')
})
