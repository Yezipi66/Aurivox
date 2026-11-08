'use strict'
// VERIFY：第 5 步：校验。按顺序调平台自己的四道校验（envCheck 的两道、checkpointStatus、
//   verifyAudio 的 verifyEngine），本文件一道都不自己实现。
// 结果带 ok / problems / ready 三态：状态未知时既不判为完整，也不判为缺失。
// 第 4 道 A 级要执行一次真实合成 ⇒ 缺 request 时如实说明不执行：请求体的键名是引擎方言，
//   平台无法构造一个用于验证音频的请求。

const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')

function platform (rel) {
  return require(path.join(ROOT, rel))
}

/**
 * 四道校验的清单。stage 把结论分成两层：
 *   preflight 只做静态核对，runtime 才代表引擎真正合成过一次。
 *   两者不可互相替代：静态全绿不等于能够出声。
 */
function checks () {
  return [
    {
      key: 'env_shallow',
      n: 1,
      stage: 'preflight',
      titleEn: 'Environment integrity',
      titleZh: '运行环境完整性',
      cost: 'cheap',
      why: 'Checks on disk whether the interpreter, the inference entrypoint and verify.sys_path are present. The engine is not started.',
      whyZh: '检查解释器、推理入口与 verify.sys_path 是否存在；仅核对文件，不启动引擎。',
    },
    {
      key: 'env_deep',
      n: 2,
      stage: 'preflight',
      titleEn: 'Engine import',
      titleZh: '引擎模块可导入',
      cost: 'slow',
      why: "Uses the engine's own interpreter to import the module, class and method declared in the manifest.",
      whyZh: '使用引擎自身的解释器，导入名片声明的模块、类与方法。',
    },
    {
      key: 'checkpoints',
      n: 3,
      stage: 'preflight',
      titleEn: 'Model weights',
      titleZh: '模型权重完整性',
      cost: 'cheap',
      why: 'Checks whether every weights file named in the manifest is present. The ready field has three states; null means the platform cannot determine it.',
      whyZh: '核对名片声明的权重文件是否齐全。ready 为三态，null 表示平台无法判定。',
    },
    {
      key: 'audio',
      n: 4,
      stage: 'runtime',
      titleEn: 'Speech synthesis',
      titleZh: '语音合成可用性',
      cost: 'heavy',
      why: 'Tier B checks the response format only; tier A performs a real synthesis and requires a non-empty WAV.',
      whyZh: 'B 级仅校验响应格式；A 级执行一次真实合成，并要求返回非空 WAV。',
    },
  ]
}

/**
 * 跑前几道（默认 1–3，第 4 道要显式要）
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
      error: `The platform cannot read the manifest for ${id}: ${e.message}`, errorZh: `平台解析不出 ${id} 的名片：${e.message}` }
  }

  const out = { ok: true, id, checks: {}, problems: [] }

  // 标题、说明与 stage 从 checks() 的清单并入每道结果：界面直接用平台的词，
  //   不另造一套标签，避免与第 2 步「安装依赖」的结论混淆。
  const meta = Object.fromEntries(checks().map((c) => [c.key, c]))
  const withMeta = (key, r) => ({ ...meta[key], ...r })

  // envCheck 收的是 profile + {rootDir}（照 tools/dev/check-engine-env.cjs 的调用处），
  //   不是 (id, env)：那样传进去 node 不会报错，但读到的全是 undefined。
  // 第 1 道：浅层
  try {
    const r = checkEngineEnvShallow(profile, { rootDir: ROOT })
    out.checks.env_shallow = withMeta('env_shallow', { key: 'env_shallow', ...r })
    if (!r.ok) out.ok = false
  } catch (e) {
    out.checks.env_shallow = withMeta('env_shallow',
      { key: 'env_shallow', ok: false, problems: [String(e.message)] })
    out.ok = false
  }

  // 第 2 道：深层
  if (opts.deep !== false) {
    try {
      const r = checkEngineEnvDeep(profile, { rootDir: ROOT })
      out.checks.env_deep = withMeta('env_deep', { key: 'env_deep', ...r })
      if (!r.ok) out.ok = false
    } catch (e) {
      out.checks.env_deep = withMeta('env_deep',
        { key: 'env_deep', ok: false, problems: [String(e.message)] })
      out.ok = false
    }
  }

  // 第 3 道：权重（三态不糊）
  try {
    const st = checkpointStatus(profile, { appDir: ROOT })
    const ready = st.ready
    out.checks.checkpoints = withMeta('checkpoints', {
      key: 'checkpoints',
      ready,
      ok: ready === true,
      note: ready === true
        ? '名片声明的权重文件齐全。'
        : ready === false
          ? `模型权重不完整。${st.reason || '未能查明原因'}`
          // 状态未知保留三态：原因取平台查明的 reason，不自行推测，
          //   以免把「声明了 checkpoints 但未声明 required」描述成缺文件。
          : `模型权重状态未知：${st.reason || '未能查明原因'}。既不能判定为完整，也不能判定为缺失。`,
      required: st.required || [],
      missing: st.missing || [],
      abs_path: st.abs_path || null,
    })
    // ready 为 null 时不计为失败，也不得计为通过
    if (ready === null) {
      out.problems.push('模型权重：状态未知（名片未声明 checkpoints 或 required）')
    }
  } catch (e) {
    out.checks.checkpoints = withMeta('checkpoints',
      { key: 'checkpoints', ok: false, problems: [String(e.message)] })
  }

  // 静态核对的结论单独汇总：它只说明声明与盘上产物一致，不代替真实合成。
  const preflight = checks().filter((c) => c.stage === 'preflight').map((c) => c.key)
  const states = preflight.map((k) => {
    const c = out.checks[k]
    if (!c) return 'unknown'
    if (k === 'checkpoints') return c.ready === true ? 'ok' : c.ready === false ? 'fail' : 'unknown'
    return c.ok === true ? 'ok' : c.ok === false ? 'fail' : 'unknown'
  })
  out.summary = {
    preflight: {
      total: preflight.length,
      passed: states.filter((s) => s === 'ok').length,
      status: states.includes('fail') ? 'fail' : states.includes('unknown') ? 'unknown' : 'ok',
    },
  }

  return out
}

/**
 * 第 4 道「语音合成可用性」：A 级缺 request 就不执行，并如实说明原因。
 *
 * 有常驻地址的引擎（名片写了 default_base_url 或 base_url_env 指过来）
 *   走原路：verifyAudio 直接请求该地址。
 * 没有地址的引擎（stdio / cli 形态）：先启动一台临时宿主，校验结束后关闭。
 *   所以本函数是 async：启动后需等待 /health，不像前三道那样只核对文件。
 */
async function runAudioCheck (id, opts = {}) {
  const level = opts.audio === 'A' ? 'A' : 'B'

  let verifyAudio
  try {
    // 文件名是驼峰 verifyAudio.js，不是 verify_audio.js（那是 .py）
    verifyAudio = platform('lib/engines/verifyAudio.js')
  } catch (e) {
    return { ok: false, code: 'NO_VERIFY_MODULE',
      error: `The platform's own lib/engines/verifyAudio.js cannot be loaded: ${e.message}`, errorZh: `平台自己的 lib/engines/verifyAudio.js 调不动：${e.message}` }
  }

  const { resolveEngineProfile } = platform('lib/engines/profile.js')
  const { requireEngine } = platform('lib/engines/registry.js')
  let profile, manifest
  try {
    // opts.profile / opts.manifest 是测试注入：生产路径（wizardbridge）不传，
    //   一律由平台解析，向导不自造名片语义。
    profile = opts.profile || resolveEngineProfile(id, process.env)
    manifest = opts.manifest || requireEngine(id)
  } catch (e) {
    return { ok: false, code: 'NO_PROFILE', error: e.message, errorZh: e.message }
  }

  // 名片未声明 runtime 时平台无法确定启动方式，此道无法执行。
  if (!profile.runtime) {
    return { ok: false, code: 'NO_RUNTIME',
      error: `The manifest for ${id} has no runtime section, so the launch method cannot be determined.`,
      errorZh: `引擎 ${id} 的名片没有 runtime 段，无法确定启动方式，因此无法执行语音合成校验。请由接入者自行验证。` }
  }

  if (level === 'A' && !opts.request) {
    // A 级必须基于使用者填写的请求执行，平台不构造合成内容。
    return {
      ok: false, code: 'NO_REQUEST', level: 'A',
      error: 'Tier A requires a real synthesis. The request body must be provided:\n'
        + 'Its key names follow the dialect declared in this manifest,\n'
        + 'and a request invented by the platform cannot verify the resulting audio.\n'
        + 'Provide the actual text and reference audio, then retry.',
      errorZh: 'A 级校验需要执行一次真实合成，请求体必须由使用者填写。\n'
        + '请求键名遵循名片声明的参数映射；平台构造的请求无法用于验证音频结果。\n'
        + '请填写合成文本与参考音频后重试。',
      expected_shape: '名片 call.bind 的槽位名：'
        + Object.keys((profile.call && profile.call.bind) || {})
          .map((k) => `${k}: '…'`).join('  ') || '(这张名片没有 call.bind)',
    }
  }

  // 界面给的是平台的词（reference_audio / reference_text），换成宿主与引擎的词再发。
  //   运行设备也从这里过一手：界面送的是「选了哪块卡」，要换成这台引擎认的写法，
  //   并且不能把设备对象本身当成引擎参数发下去。
  const reqIn = opts.request ? { ...opts.request } : null
  const pickedDevice = reqIn && reqIn.device ? reqIn.device : null
  if (reqIn) delete reqIn.device
  const request = reqIn ? require('./measure').toEngineWords(profile, reqIn) : null
  if (request && pickedDevice) {
    const { resolveDeviceArgs } = require('../../../lib/engines/deviceValue')
    // 名片里没声明运行设备的引擎，这里得到空对象，等于这次不传，引擎用自己的默认值。
    Object.assign(request, resolveDeviceArgs(profile.call || {}, pickedDevice))
  }

  // 打一次验证。base_url 给了就替换成临时宿主的地址（拉起器专用），
  //   没给（null）就用 profile 原样：有常驻地址的引擎走老路。
  //   opts.verifyEngine 也是测试注入：默认就是平台那个，不重写。
  const verifyEngine = typeof opts.verifyEngine === 'function'
    ? opts.verifyEngine : (o) => verifyAudio.verifyEngine(o)
  const verifyOnce = (baseUrl) => verifyEngine({
    profile: baseUrl ? { ...profile, base_url: baseUrl } : profile,
    manifest, level, request, root: ROOT,
  })

  const hasBaseUrl = typeof profile.base_url === 'string' && profile.base_url.trim()
  if (hasBaseUrl) {
    try {
      const r = verifyOnce(null)
      return { ok: r.ok !== false, level, ...r }
    } catch (e) {
      return { ok: false, code: 'AUDIO_FAILED', level,
        error: String((e && e.message) || e) }
    }
  }

  // 没有常驻地址：拉一台临时宿主。verifyEngine 的参数校验失败会抛
  //   （例如 A 级缺 text），那也是「要改名片」而不是「引擎坏了」，照常带回来。
  const hostRunner = opts.hostRunner || require('./hostRunner')
  const hosted = await hostRunner.withTempHost({
    id, profile, root: ROOT,
    run: (base) => verifyOnce(base),
  })
  if (!hosted.ok) {
    return { ok: false, code: 'HOST_FAILED', level, stage: hosted.stage,
      error: `The local host required for the synthesis check could not be started (${hosted.stage}): ${hosted.error}`,
      errorZh: `语音合成校验所需的本地宿主未能启动（阶段：${hosted.stage}）：${
        hosted.error || ''}${hosted.stderr ? `（宿主输出：${hosted.stderr.slice(-600)}）` : ''}`,
      stderr: hosted.stderr || null }
  }
  const r = hosted.result
  return { ok: r.ok !== false, level, ...r }
}
module.exports = { checks, runChecks, runAudioCheck }