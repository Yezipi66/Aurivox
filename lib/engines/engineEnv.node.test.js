'use strict'

// 引擎子进程的环境：运行期缓存的落点。
//   判据是「环境变量里到底有没有」：缓存不指对时，第三方包会把权重下到
//   用户家目录里，平台既看不见，删引擎也不跟着走。

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const P = require('../paths')
const { engineChildEnv } = require('./engineEnv')

test('运行期缓存指向平台的公共目录（HF / 魔搭 / torch 各一个）', () => {
  const env = engineChildEnv({ base: { PATH: '/bin' } })
  assert.strictEqual(env.HF_HOME, P.HF_HOME_DIR)
  assert.strictEqual(env.MODELSCOPE_CACHE, P.MODELSCOPE_CACHE_DIR)
  assert.strictEqual(env.TORCH_HOME, P.TORCH_HOME_DIR)
  // 三处不许是同一个目录：混在一起时谁覆盖谁无从判断。
  assert.notStrictEqual(env.HF_HOME, env.MODELSCOPE_CACHE)
  assert.notStrictEqual(env.MODELSCOPE_CACHE, env.TORCH_HOME)
})

test('继承来的缓存目录被顶掉：不顶，继承值会盖掉平台指定的落点', () => {
  const env = engineChildEnv({
    base: {
      PATH: '/bin',
      HF_HOME: 'C:/users/somebody/.cache/huggingface',
      MODELSCOPE_CACHE: 'C:/users/somebody/.cache/modelscope',
      TORCH_HOME: 'C:/users/somebody/.cache/torch',
    },
  })
  assert.ok(!String(env.HF_HOME).includes('somebody'), '继承值没被顶掉：' + env.HF_HOME)
  assert.ok(!String(env.MODELSCOPE_CACHE).includes('somebody'))
  assert.ok(!String(env.TORCH_HOME).includes('somebody'))
})

test('PYTHONPATH / VIRTUAL_ENV 必须剥掉：继承后引擎 import 到别的 venv 的包', () => {
  const env = engineChildEnv({
    base: { PATH: '/bin', PYTHONPATH: 'D:/other/venv/Lib/site-packages', VIRTUAL_ENV: 'D:/other/venv' },
  })
  assert.ok(!('PYTHONPATH' in env), 'PYTHONPATH 没剥掉')
  assert.ok(!('VIRTUAL_ENV' in env), 'VIRTUAL_ENV 没剥掉')
})

test('缓存目录被建出来：huggingface_hub 要求它存在', () => {
  const env = engineChildEnv({ base: { PATH: '/bin' } })
  assert.ok(fs.existsSync(env.HF_HOME), 'huggingface 缓存目录没建')
  assert.ok(fs.existsSync(env.MODELSCOPE_CACHE), 'modelscope 缓存目录没建')
  assert.ok(fs.existsSync(env.TORCH_HOME), 'torch 缓存目录没建')
})

test('给了引擎 id：缓存落在它自己的目录下，不再共用全局目录', () => {
  const id = '__cache_probe__'
  const env = engineChildEnv({ base: { PATH: '/bin' }, id })
  try {
    assert.ok(env.HF_HOME.includes(path.join('engines', id, '.cache')),
      '缓存没落在引擎目录下：' + env.HF_HOME)
    assert.notStrictEqual(env.HF_HOME, P.HF_HOME_DIR,
      '还在共用全局目录：删这台引擎时缓存带不走')
    // 三处仍然各一个：混在一起时谁覆盖谁无从判断。
    assert.notStrictEqual(env.HF_HOME, env.MODELSCOPE_CACHE)
    assert.notStrictEqual(env.MODELSCOPE_CACHE, env.TORCH_HOME)
  } finally {
    fs.rmSync(path.join(P.APP_DIR, 'engines', id), { recursive: true, force: true })
  }
})

test('两台引擎的缓存互不重叠', () => {
  const a = engineChildEnv({ base: {}, id: '__cache_probe_a__' })
  const b = engineChildEnv({ base: {}, id: '__cache_probe_b__' })
  try {
    assert.notStrictEqual(a.HF_HOME, b.HF_HOME, '两台引擎指向了同一个缓存目录')
  } finally {
    for (const id of ['__cache_probe_a__', '__cache_probe_b__']) {
      fs.rmSync(path.join(P.APP_DIR, 'engines', id), { recursive: true, force: true })
    }
  }
})

test('两条拉起路径共用这一份环境：常驻与第 5 步临时宿主', () => {
  // 各写一遍的话，向导里验不过而平台跑得起来（或反过来），差别只在环境变量上，
  //   排查时看不出是哪一处漏了。判据是「两边都调这一个函数」。
  const spawn = fs.readFileSync(path.join(__dirname, 'spawnEngine.js'), 'utf8')
  const runner = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'engine-wizard', 'core', 'hostRunner.js'), 'utf8')
  assert.ok(/engineChildEnv\s*\(/.test(spawn), 'spawnEngine 没用共享的环境构造')
  assert.ok(/engineChildEnv\s*\(/.test(runner), 'hostRunner 没用共享的环境构造')
})