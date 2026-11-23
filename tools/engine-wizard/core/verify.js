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
 * 给失败结论补上「为什么」与「怎么办」。
 * 口径只有一份（lib/engines/diagnose.js），9886 那条合成口用的是同一份：
 * 同一段 stderr 从两个入口出去，各判一次迟早给出两种说法。
 * 结果里已有 cause 的（探针自己就知道的事实）原样保留，不覆盖。
 */
function withDiagnosis (r) {
  if (!r || r.ok !== false || (r.cause && r.hint)) return r
  // 没有原文就无从判断：让界面显示 error 那句（它本身已经是人话）。
  const text = r.detail || r.host_stderr || ''
  if (!text) return r
  let diagnose
  try {
    diagnose = platform('lib/engines/diagnose.js').diagnose
  } catch {
    return r
  }
  const status = Number.isFinite(r.status) ? r.status : null
  const d = diagnose(text, status)
  // cause/hint 是中文，causeEn/hintEn 是同一句的英文：前端按语言取。
  //   英文缺了会回落到中文（见 StepVerify 的 pickLang），不会显示空白。
  return {
    ...r,
    cause: r.cause || d.cause,
    causeEn: r.causeEn || d.causeEn,
    hint: r.hint || d.hint,
    hintEn: r.hintEn || d.hintEn,
  }
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
      why: 'Checks whether the interpreter, the inference entrypoint and verify.sys_path declared in the manifest exist on disk.',
      whyZh: '核对名片声明的解释器、推理入口与 verify.sys_path 是否存在于磁盘。',
    },
    {
      key: 'env_deep',
      n: 2,
      stage: 'preflight',
      titleEn: 'Engine import',
      titleZh: '引擎模块可导入',
      cost: 'slow',
      // 只验启动环境：探针在 import 期间强制离线，不会替引擎下任何权重。
      //   这句话要写在说明里：缺运行期资源时导入会失败，读的人得知道那是
      //   「权重还没下」而不是「包没装」，不要去重装环境。
      why: "Uses the engine's own interpreter to import the module, class and method declared in the manifest. The probe runs offline, so an import that needs a runtime resource fails here and the reason is reported.",
      whyZh: '使用引擎自身的解释器，导入名片声明的模块、类与方法。探针在离线状态下运行，需要运行期资源的导入会在此失败，并给出原因。',
    },
    {
      key: 'checkpoints',
      n: 3,
      stage: 'preflight',
      titleEn: 'Model weights',
      titleZh: '模型权重完整性',
      cost: 'cheap',
      why: 'Checks whether every weights file named in the manifest is present and reports the result as present, missing, or undetermined. Resources the engine fetches on its first inference are listed alongside the result.',
      whyZh: '核对名片声明的权重文件是否齐全，结论为齐全、缺失或无法判定。引擎首次推理时自行拉取的资源随结果一并列出。',
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
  const { requireEngine } = platform('lib/engines/registry.js')

  let profile, manifest
  try {
    profile = resolveEngineProfile(id, process.env)
    // profile 有意不透出 call（那是宿主契约，前端碰它就成第二份）：
    //   verify.imports 空着时要用推理入口现算，这段从名片里单独取。
    manifest = requireEngine(id)
  } catch (e) {
    return { ok: false, code: 'NO_PROFILE',
      error: `The platform cannot read the manifest for ${id}: ${e.message}`, errorZh: `平台解析不出 ${id} 的名片：${e.message}` }
  }

  const out = { ok: true, id, checks: {}, problems: [] }
  // 名片声明了补齐命令时，第 5 步也给人一个「补齐并重新校验」的入口：
  // 资源是运行期才发现的，不必为此回到第 3 步重走一遍。
  out.post_download_available = !!(profile && profile.models &&
    profile.models.post_download && Array.isArray(profile.models.post_download.command) &&
    profile.models.post_download.command.length)

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
      const r = checkEngineEnvDeep(profile, { rootDir: ROOT, call: manifest && manifest.call })
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
        ? 'Every weights file named in the manifest is present.'
        : ready === false
          ? `The weights are incomplete. ${st.reasonEn || st.reason || 'the cause could not be determined'}`
          : `Weights status unknown: ${st.reasonEn || st.reason || 'the cause could not be determined'}. `
            + 'It can be called neither complete nor missing.',
      noteZh: ready === true
        ? '名片声明的权重文件齐全。'
        : ready === false
          ? `模型权重不完整。${st.reason || '未能查明原因'}`
          : `模型权重状态未知：${st.reason || '未能查明原因'}。既不能判定为完整，也不能判定为缺失。`,
      required: st.required || [],
      missing: st.missing || [],
      // 有 .tmp 没正式文件 = 下载中途停了（继续下载即可），与「从没下过」分开说。
      partial: st.partial || [],
      // 正式文件在、同名 .tmp 也在：不影响判定，只提示有未清理的临时文件。
      stale_tmp: st.stale_tmp || [],
      // 名片把临时文件名写进了 required：名片的问题，不是盘的问题。
      declared_tmp: st.declared_tmp || [],
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
  return withDiagnosis(await runAudioCheckRaw(id, opts))
}

async function runAudioCheckRaw (id, opts = {}) {
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
    // 验证器自己的输出也实时转：它是这条链上唯一说明「正在做什么」的字。
    onLine: opts.onLine,
  })

  const hasBaseUrl = typeof profile.base_url === 'string' && profile.base_url.trim()
  if (hasBaseUrl) {
    try {
      const r = await verifyOnce(null)
      return { ok: r.ok !== false, level, ...r }
    } catch (e) {
      const msg = String((e && e.message) || e)
      return { ok: false, code: 'AUDIO_FAILED', level, error: msg, errorZh: msg,
        cause: 'The check never started: the host or the probe failed before this step',
        causeZh: '校验没有跑起来，宿主或探针在这一步之前就出错了',
        hint: 'Read the raw output below; when the manifest is wrong (entrypoint, interpreter, '
          + 'slot name) the error is usually in the first few lines.',
        hintZh: '看下方原文；名片写错（入口、解释器、槽位名）时错误通常出在最前面几行。' }
    }
  }

  // 没有常驻地址：拉一台临时宿主。verifyEngine 的参数校验失败会抛
  //   （例如 A 级缺 text），那也是「要改名片」而不是「引擎坏了」，照常带回来。
  const hostRunner = opts.hostRunner || require('./hostRunner')
  const hosted = await hostRunner.withTempHost({
    id, profile, root: ROOT,
    run: (base) => verifyOnce(base),
    // 调用方要实时看输出时把回调递进来（第 5 步的流式端点）。
    //   不传时与以前一致：只在结束时拿到两路全文。
    onLine: opts.onLine,
  })
  if (!hosted.ok) {
    // 宿主的两路输出各自给一份全文：stderr 常含真正的根因（缺模块、权重路径、
    //   torch 版本），stdout 是引擎自己说的话（模型路径、加载进度）。
    //   合成一摞时界面只能笼统叫「stderr」，读的人分不清哪句是失败原因、哪句是正常输出。
    const stderr = hosted.stderr || ''
    const stdout = hosted.stdout || ''
    // 宿主那一句原文按语言取：hostRunner 给的是成对的（error / errorEn）。
    //   只取一份的话，英文界面里会嵌一段中文，读的人分不清那是原文还是缺陷。
    const rawEn = hosted.errorEn || hosted.error || ''
    const rawZh = hosted.error || ''
    return { ok: false, code: 'HOST_FAILED', level, stage: hosted.stage,
      error: `The local host required for the synthesis check could not be started (${hosted.stage})`
        + `${rawEn ? `: ${rawEn}` : ''}`,
      errorZh: `语音合成校验所需的本地宿主未能启动（阶段：${hosted.stage}）。`
        + `${rawZh ? `宿主报告的原文：${rawZh}` : ''}`
        + `${(stderr || stdout) ? ' 宿主进程的输出见下方。' : ''}`,
      cause: 'The host process failed to start, or exited immediately after starting',
      causeZh: '宿主进程启动失败，或启动后立即退出',
      hint: 'Match the host output below to an action: '
        + '"No module named" → go back to step 2 and install the missing dependency; '
        + 'a weights/path error → check the storage location in step 3; '
        + 'a torch/device error → go back to step 2 and change the Torch backend or version. '
        + 'If none matches, send the output below to the maintainer.',
      hintZh: '按下方宿主输出选择操作：'
        + '出现 No module named → 回第 2 步补装缺失的依赖；'
        + '出现权重或路径报错 → 核对第 3 步的存放位置；'
        + '出现 torch 或设备报错 → 回第 2 步更换 Torch 后端或版本。'
        + '都不匹配就把下方输出发给维护者。',
      host_stdout: stdout || null,
      host_stderr: stderr || null }
  }
  const r = hosted.result
  return { ok: r.ok !== false, level, ...r }
}
/**
 * 第 5 步 A 级执行完成后，把结论写进名片的 acceptance 节。
 * 读磁盘三节原文（契约哈希必须基于原样的三节，不能用投影视图），
 * 写完经 saveManifest 走原子写 + 备份。写失败不抛：验收结论照常展示给用户，
 * 只是这次没留下记录，如实回报原因。
 * @returns {{ok:boolean, acceptance?:object, error?:string}}
 */
function persistAcceptance (id, opts = {}) {
  const o = opts || {}
  let manifestPath
  try {
    manifestPath = platform('tools/engine-wizard/core/wizardRoot.js').manifestPathForRead(id)
  } catch { manifestPath = null }
  if (!manifestPath) return { ok: false, error: '找不到这张名片的落盘路径' }
  let raw
  try { raw = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8')) }
  catch (e) { return { ok: false, error: `名片读不出来：${e.message}` } }

  const acceptance = platform('lib/engines/acceptance.js').buildAcceptance({
    manifestV011: raw,
    profile: o.profile,
    request: o.request,
    result: o.result,
    engineCwd: raw.registration && raw.registration.environment
      ? raw.registration.environment.cwd : null,
    root: ROOT,
  })
  const enginesDir = path.dirname(path.dirname(manifestPath))
  const { saveManifest } = require('./save')
  const saved = saveManifest(raw, { enginesDir, overwrite: true, acceptance })
  if (!saved.ok) return { ok: false, error: saved.error, code: saved.code }
  return { ok: true, acceptance }
}

module.exports = { checks, runChecks, runAudioCheck, withDiagnosis, persistAcceptance }