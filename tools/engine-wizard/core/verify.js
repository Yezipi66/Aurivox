'use strict'
// ============================================================================
//  VERIFY —— 第 7 步：校验
//
//  ⭐ 本文件**不判断任何事**。四道校验平台全都有实现，这里只做三件事：
//    1. 按顺序调它们
//    2. 如实把结果传出去（ok / problems / ready 三态）
//    3. ⛔ 不把「说不出来」说成「齐了」或「缺了」
//
//  ⭐ 四道校验各自的权威实现（⛔ 一个都不许在这里重写）：
//    第 1 道 浅层「装没装」   lib/engines/envCheck.js:checkEngineEnvShallow
//    第 2 道 深层「起不起来」 lib/engines/envCheck.js:checkEngineEnvDeep
//    第 3 道 「齐不齐」       lib/engines/checkpoints.js:checkpointStatus
//    第 4 道 「出不出声」     lib/engines/verifyAudio.js（verifyEngine）
//
//  ⛔⛔ 关于第 4 道（A 级）
//   它要**真的合成一次**。tools/verify-engine.cjs:63 那段注释写着：
//   「A 级要真的合成。请给一份请求体」——⛔ 平台要你交一份请求体，
//   它不会自己编一个（编出来的请求验不了「声音对不对」）。
//   ⇒ 所以 A 级缺 request 时，本文件**如实说不给跑**，不糊一个假的上去。
//
//  ⛔⛔ 纪律：不许出现任何具体引擎名。
// ============================================================================

const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')

function platform (rel) {
  return require(path.join(ROOT, rel))
}

/** ⭐ 四道校验的清单 —— ⛔ 顺序与文案都照平台自己的说法 */
function checks () {
  return [
    {
      key: 'env_shallow',
      n: 1,
      titleEn: 'Installed',
      titleZh: '装没装',
      // 「纯查盘，几毫秒」
      cost: 'cheap',
      why: '纯查盘：解释器在不在、入口在不在、verify.sys_path 在不在',
    },
    {
      key: 'env_deep',
      n: 2,
      titleEn: 'Starts',
      titleZh: '起不起来',
      // 「慢（实测三十多秒）」
      cost: 'slow',
      why: '起这台引擎自己的解释器去 import 名片点名的模块/类/方法',
    },
    {
      key: 'checkpoints',
      n: 3,
      titleEn: 'Weights',
      titleZh: '权重齐不齐',
      cost: 'cheap',
      why: '名片说的那几个文件缺不缺（ready 是三态，null = 说不出来）',
    },
    {
      key: 'audio',
      n: 4,
      titleEn: 'Speaks',
      titleZh: '出不出声',
      cost: 'heavy',
      why: 'B 级只要合法响应；A 级真跑一次合成拿非空 WAV',
    },
  ]
}

/**
 * ⭐ 跑前几道（⛔ 默认 1–3，第 4 道要显式要）
 *
 * @param {string} id
 * @param {{audio?: 'B'|'A', request?:object}} opts
 */
function runChecks (id, opts = {}) {
  const { checkEngineEnvShallow, checkEngineEnvDeep } = platform('lib/engines/envCheck.js')
  const { checkpointStatus } = platform('lib/engines/checkpoints.js')
  const { resolveEngineProfile } = platform('lib/engines/profile.js')

  let profile
  try {
    profile = resolveEngineProfile(id, process.env)
  } catch (e) {
    return { ok: false, code: 'NO_PROFILE',
      error: `平台解析不出 ${id} 的名片：${e.message}` }
  }

  const out = { ok: true, id, checks: {}, problems: [] }

  // ⚠ envCheck 收的是 **profile + {rootDir}**（照 tools/dev/check-engine-env.cjs:86）
  //   ⛔ 不是 (id, env) —— 那样传进去 node 不会报错，但读到的全是 undefined。
  // ---- 第 1 道：浅层 ----
  try {
    const r = checkEngineEnvShallow(profile, { rootDir: ROOT })
    out.checks.env_shallow = { key: 'env_shallow', ...r }
    if (!r.ok) out.ok = false
  } catch (e) {
    out.checks.env_shallow = { key: 'env_shallow', ok: false,
      problems: [String(e.message)] }
    out.ok = false
  }

  // ---- 第 2 道：深层 ----
  if (opts.deep !== false) {
    try {
      const r = checkEngineEnvDeep(profile, { rootDir: ROOT })
      out.checks.env_deep = { key: 'env_deep', ...r }
      if (!r.ok) out.ok = false
    } catch (e) {
      out.checks.env_deep = { key: 'env_deep', ok: false,
        problems: [String(e.message)] }
      out.ok = false
    }
  }

  // ---- 第 3 道：权重（⛔ 三态不糊）----
  try {
    const st = checkpointStatus(profile, { appDir: ROOT })
    const ready = st.ready
    out.checks.checkpoints = {
      key: 'checkpoints',
      // ⭐ ready 三态照抄 —— ⛔ 别把它压成布尔
      ready,
      ok: ready === true,
      note: ready === true
        ? '名片说的文件一个不少'
        : ready === false
          ? '目录不在，或名片点名的文件缺了'
          // ⛔ null 的原话（checkpoints.js:84-91）
          : '⚠ 说不出来 —— 名片没写 runtime.checkpoints，'
            + '或没写 models.required（哪几个文件算齐）'
            + '⛔ 这不等于「齐了」，也不等于「缺了」',
      required: st.required || [],
      missing: st.missing || [],
      abs_path: st.abs_path || null,
    }
    // ⛔ ready:null 不算失败，但也**不许当成通过**
    if (ready === null) {
      out.problems.push('权重：说不出来（名片缺 checkpoints 或 required）')
    }
  } catch (e) {
    out.checks.checkpoints = { key: 'checkpoints', ok: false,
      problems: [String(e.message)] }
  }

  return out
}

/**
 * ⭐ 第 4 道「出不出声」—— A 级要真的合成。
 *
 * ⛔⛔ **不给 request 就不跑**，并如实说明为什么。
 *   理由照 tools/verify-engine.cjs:63：请求体里的键名是**引擎方言**
 *   （照 manifest.json 的 maps 写）—— ⛔ 平台编不出一个对的。
 */
function runAudioCheck (id, opts = {}) {
  const level = opts.audio === 'A' ? 'A' : 'B'

  let verifyAudio
  try {
    // ⚠ 文件名是驼峰 verifyAudio.js，⛔ 不是 verify_audio.js（那是 .py）
    verifyAudio = platform('lib/engines/verifyAudio.js')
  } catch (e) {
    return { ok: false, code: 'NO_VERIFY_MODULE',
      error: `平台自己的 lib/engines/verifyAudio.js 调不动：${e.message}` }
  }

  const { resolveEngineProfile } = platform('lib/engines/profile.js')
  const { requireEngine } = platform('lib/engines/registry.js')
  let profile, manifest
  try {
    profile = resolveEngineProfile(id, process.env)
    manifest = requireEngine(id)
  } catch (e) {
    return { ok: false, code: 'NO_PROFILE', error: e.message }
  }

  // ⛔ 名片没写 runtime ⇒ 平台不负责起它 ⇒ 这一道无从谈起
  //   （verify-engine.cjs:47 那段注释的原话）
  if (!profile.runtime) {
    return { ok: false, code: 'NO_RUNTIME',
      error: `引擎 ${id} 的名片没有 runtime 段，无法确定启动方式。`
        + '也就无从替它验「出不出得了声」。这一道要由起它的人自己做。' }
  }

  if (level === 'A' && !opts.request) {
    // ⭐ A 级要真的合成 ⇒ 平台**不会编一个请求体**
    return {
      ok: false, code: 'NO_REQUEST', level: 'A',
      error: 'A 级要真的合成一次。请求体需要用户填写：'
        + '里面的键名是**引擎方言**（照这张名片的 maps 写），'
        + '编出来的请求验不了「声音对不对」。\n'
        + '你在向导里填一份真实的（文本 + 参考音频），我再跑。',
      expected_shape: '照名片 call.bind 的槽位名：'
        + Object.keys((profile.call && profile.call.bind) || {})
          .map((k) => `${k}: '…'`).join('  ') || '(这张名片没有 call.bind)',
    }
  }

  try {
    const r = verifyAudio.verifyEngine({
      profile, manifest, level, request: opts.request || null, root: ROOT,
    })
    return { ok: r.ok !== false, level, ...r }
  } catch (e) {
    return { ok: false, code: 'AUDIO_FAILED', level,
      error: String((e && e.message) || e) }
  }
}

module.exports = { checks, runChecks, runAudioCheck }