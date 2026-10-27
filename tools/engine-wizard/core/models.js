'use strict'
//  MODELS：第 4 步：把「要下什么」摆出来
//
//  这里的全部产出是「一段可以照抄的命令」+「缺哪些文件」。

const path = require('node:path')

function platformCheckpoints () {
  return require(path.join(__dirname, '..', '..', '..',
    'lib', 'engines', 'checkpoints.js'))
}

/**
 * 拿到平台自己解析出来的 profile。
 */
function platformProfile (id) {
  const { resolveEngineProfile } = require(path.join(__dirname, '..', '..', '..',
    'lib', 'engines', 'profile.js'))
  return resolveEngineProfile(id)
}

function t_missingHint (status) {
  if (!status.declared) {
    return 'Manifest 未声明 runtime.checkpoints，无法确定 Checkpoint 的存放位置'
  }
  return 'Manifest 未声明具体文件（models.required 为空），无法判断是否完整'
}

/**
 * 一台引擎的权重现状：只查，不下。
 *
 * @param {string} id 引擎 id（走平台 registry 拿 profile）
 * @returns {{ok:true, status:object, commands:string[], notes:string[]}
 *          | {ok:false, code, error, example?}}
 */
function describeModels (id, appDir) {
  let cp
  try {
    cp = platformCheckpoints()
  } catch (e) {
    return { ok: false, code: 'NO_PLATFORM_MODULE',
      error: `The platform's own lib/engines/checkpoints.js cannot be loaded: ${e.message}`, errorZh: `平台自己的 lib/engines/checkpoints.js 调不动：${e.message}` }
  }

  let profile
  try {
    profile = platformProfile(id)
  } catch (e) {
    const notInstalled = e && e.code === 'FG_ENGINE_UNSUPPORTED'
    return { ok: false, code: 'NO_PROFILE',
      error: notInstalled
        ? e.message
        : `平台无法解析 ${id} 的 Manifest：${e.message}\n`
          + '该问题会在第 4 步保存 Manifest 时提示。' }
  }

  let status
  try {
    status = cp.checkpointStatus(profile, { appDir })
  } catch (e) {
    return { ok: false, code: 'STATUS_FAILED',
      error: `The platform cannot determine this engine's checkpoint state: ${e.message}`, errorZh: `平台算不出这台引擎的权重现状：${e.message}` }
  }

  const notes = []
  if (status.ready === true) {
    notes.push('Manifest 声明的文件全部存在')
  } else if (status.ready === false) {
    notes.push('目录不存在，或 Manifest 声明的文件缺失')
  } else {
    // ready 为 null 时不能压成 false 或 true：
    //   压 false 会让可用的引擎永远显示为缺失，压 true 等于替 Manifest
    //   作者担保一件他没有声明的事。⇒ 如实说「状态未知」。
    notes.push('状态未知：Manifest 未声明 runtime.checkpoints，'
      + '或未声明 models.required（用于判断哪些文件算完整）')
    notes.push('既不能视为完整，也不能视为缺失。')
  }

  const src = (status.source) || {}
  const commands = []
  if (src.url) {
    notes.push(`模型主页：${src.url}`)
  }
  if (src.cwd) {
    notes.push(`在 ${src.cwd} 下执行：`)
  }
  if (Array.isArray(src.command) && src.command.length) {
    // 权威实现已经把 {checkpoints} 填成绝对路径了：直接用
    commands.push(...src.command)
  } else if (src.command) {
    commands.push(String(src.command))
  } else {
    notes.push('Manifest 未声明 models.source.command，无命令可显示。'
      + '请在 Manifest 中补充该命令，或按上游说明自行下载。')
  }

  // license_gate 是布尔（profile/models.js 的 parseModelsSource 写的是 `=== true`），
  //   别把它的值当文字显示：那会是「true」两个字。
  if (src.license_gate) {
    notes.push('该模型需先在发布页接受许可协议，否则下载将返回 401 或 403。'
      + '（Manifest 中 models.source.license_gate = true 即表示此意）')
  }

  //     where 下到哪（绝对路径，平台算的）
  //     need  哪些文件算「齐」（名片点名的）
  //     have  现在有哪些
  //     miss  还缺哪些
  //     state ready 三态原文照搬
  const items = (status.required || []).map((f) => ({
    name: f,
    have: !!(status.missing && !status.missing.includes(f)),
    need: true,
  }))
  if (items.length === 0) {
    items.push({
      name: null,
      have: null,
      need: false,
      why: t_missingHint(status),
    })
  }
  const manifest = {
    where: status.abs_path || null,
    where_source: status.path_source || null,
    from: (status.source && status.source.url) || null,
    state: status.ready,
    items,
    commands,
  }

  return { ok: true, status, commands, notes, manifest }
}

/**
 * 缺了哪些文件：把三态里那个 null 拆成「说不出来」的具体原因。
 */
function explainMissingInfo (profile) {
  const gaps = []
  const rt = profile && profile.runtime
  const md = (profile && profile.models) || {}

  if (!rt || !rt.checkpoints) {
    gaps.push({
      key: 'runtime.checkpoints',
      why: 'Checkpoint location is not declared — the platform can only tell whether the directory exists, not whether it is complete.',
      whyZh: '未声明 Checkpoint 存放位置，平台只能判断目录是否存在，无法判断是否完整',
      example: 'models/tts/<引擎id>',
    })
  }
  if (!md.required || (Array.isArray(md.required) && md.required.length === 0)) {
    gaps.push({
      key: 'models.required',
      why: 'No file list is declared for integrity checks — the platform can only report unknown.',
      whyZh: '未声明用于判断完整性的文件清单，平台只能返回「状态未知」',
      example: ['model.pt', 'config.yaml'],
    })
  }
  return gaps
}

module.exports = { describeModels, explainMissingInfo }