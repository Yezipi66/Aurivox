'use strict'
// ============================================================================
//  MODELS —— 第 4 步：把「要下什么」摆出来
//
//  ⭐ 本文件**一个字节都不下载**。
//
//  为什么（engines/_TEMPLATE/README.md:101，原话）：
//    「平台**不替你下载**，但会把你名片里写的那条命令**填好占位符直接打印给你**。」
//  ⇒ 所以这里的全部产出是「一段可以照抄的命令」+「缺哪些文件」。
//
//  ⭐ 为什么调平台而不是自己写
//  占位符替换的权威实现是 lib/engines/checkpoints.js:77 的 fillPlaceholders，
//  三道校验也读同一份实现。⛔ 自己写一遍替换规则 = 两个地方会漂。
//  ⇒ 这里 require 平台的 checkpointStatus，不重新实现。
//
// ⛔⛔ 纪律：不许出现任何具体引擎名，也不许出现任何下载器名
//   （checkpoints.js:23 的同一条纪律：命令是名片写的，平台只填占位符）。
//   ⛔ 注意这条纪律**连注释里也不许**出现那些名字 ——
//     写下来就等于留了一份「本平台支持哪些下载器」的清单，
//     而那恰恰是不该由平台知道的东西。
// ============================================================================

const path = require('node:path')

/** ⛔ 平台的权重检查实现（权威：占位符替换 + 三态 ready 都在里面） */
function platformCheckpoints () {
  return require(path.join(__dirname, '..', '..', '..',
    'lib', 'engines', 'checkpoints.js'))
}

/**
 * ⭐ 拿到**平台自己解析出来的** profile。
 *
 * ⚠⚠ 踩过的坑：checkpointStatus 收的是 profile，不是原始 manifest。
 * profile.models 是 parseModels 的产物（数组，有 .slice()），
 * 拿裸 manifest 喂进去会炸在 `models.required.slice()`。
 * ⇒ 所以这里走平台的 resolveEngineProfile（它同时跑 checkTopKeys 等校验），
 * ⛔ 不手工拼一个「像 profile 的东西」。
 */
function platformProfile (id) {
  const { resolveEngineProfile } = require(path.join(__dirname, '..', '..', '..',
    'lib', 'engines', 'profile.js'))
  return resolveEngineProfile(id)
}

/**
 * ⭐ 一台引擎的权重现状 —— **只查，不下**。
 *
 * @param {string} id 引擎 id（走平台 registry 拿 profile）
 * @returns {{ok:true, status:object, commands:string[], notes:string[]}
 *          | {ok:false, code, error, example?}}
 */
/** 名片没点名任何文件时，表里那一行写什么 */
function t_missingHint (status) {
  if (!status.declared) {
    return 'Manifest 未声明 runtime.checkpoints，无法确定 Checkpoint 的存放位置'
  }
  return 'Manifest 未声明具体文件（models.required 为空），无法判断是否完整'
}

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
    // ⛔ 这两种原因要分开说，⛔ 且**不能指向第 5 步**：
    //   describeModels 跑在第 3 步，而 Manifest 第 4 步才写 ⇒
    //   「去第 5 步检查」指向一个还不存在的 Manifest。
    //   · 未安装   ⇒ 下一步是第 1 步（把仓库克隆下来）
    //   · 装了但解析失败 ⇒ 第 4 步保存时 validate() 当场就会报，
    //     ⛔ 不必等到第 5 步
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

  // ---- ⭐ ready 是**三态**，糊成布尔就是撒谎（checkpoints.js:84-91 的原话）----
  const notes = []
  if (status.ready === true) {
    notes.push('Manifest 声明的文件全部存在')
  } else if (status.ready === false) {
    notes.push('目录不存在，或 Manifest 声明的文件缺失')
  } else {
    // ⛔ ready 为 null 时**不能**压成 false 或 true：
    //   压 false 会让可用的引擎永远显示为缺失，压 true 等于替 Manifest
    //   作者担保一件他没有声明的事。⇒ 如实说「状态未知」。
    notes.push('状态未知：Manifest 未声明 runtime.checkpoints，'
      + '或未声明 models.required（用于判断哪些文件算完整）')
    notes.push('既不能视为完整，也不能视为缺失。')
  }

  // ---- 命令：名片写的，平台只填占位符 ----
  const src = (status.source) || {}
  const commands = []
  if (src.url) {
    notes.push(`模型主页：${src.url}`)
  }
  if (src.cwd) {
    notes.push(`在 ${src.cwd} 下执行：`)
  }
  if (Array.isArray(src.command) && src.command.length) {
    // ⛔ 权威实现已经把 {checkpoints} 填成绝对路径了 —— 直接用
    commands.push(...src.command)
  } else if (src.command) {
    commands.push(String(src.command))
  } else {
    notes.push('Manifest 未声明 models.source.command，无命令可显示。'
      + '请在 Manifest 中补充该命令，或按上游说明自行下载。')
  }

  // ⛔ license_gate 是**布尔**（profile.js:613 `=== true`），
  //   ⛔ 别把它的值当文字显示 —— 那会是「true」两个字。
  if (src.license_gate) {
    notes.push('该模型需先在发布页接受许可协议，否则下载将返回 401 或 403。'
      + '（Manifest 中 models.source.license_gate = true 即表示此意）')
  }

  // ⭐⭐⭐ **下载清单**（2026-10-05 Owner：「我们列出一个表，说要下这些模型就可以了」）
  //
  // ⛔ 之前这里只回 commands（几行命令），用户要自己从命令里读出
  //   「要下哪个模型、下到哪、哪个已经下好了」。
  // ✅ 现在给一张表能直接看的数据：
  //     name  模型叫什么（⛔ 说不出来就不编，标 null）
  //     where 下到哪（绝对路径，平台算的）
  //     need  哪些文件算「齐」（名片点名的）
  //     have  现在有哪些
  //     miss  还缺哪些
  //     state ready 三态 그대로
  const items = (status.required || []).map((f) => ({
    name: f,
    have: !!(status.missing && !status.missing.includes(f)),
    need: true,
  }))
  // 名片没点名文件（required 为空）⇒ 表里给一行「没点名」
  if (items.length === 0) {
    items.push({
      name: null,
      have: null,
      need: false,
      why: t_missingHint(status),
    })
  }
  const manifest = {
    // ⚠ 2026-10-05 Owner 定的口径：
    //   「我们决定 TTS 模型**不统一**放在 ./models/TTS 了，没办法统一管理，
    //     **只能统一管理引擎**」
    //   ⇒ 这张表**不再暗示**平台会给所有模型安排位置，
    //     where 就是名片 runtime.checkpoints 写的那个绝对路径，仅此而已。
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
 * ⭐ 缺了哪些文件 —— 把三态里那个 null 拆成「说不出来」的具体原因。
 *
 *  这两个字段缺一不可（_TEMPLATE/README.md:108-112）：
 *    runtime.checkpoints —— 放哪
 *    models.required     —— 哪几个文件算齐
 *  只写前者 ⇒ 平台只能告诉你目录在不在，说不出齐不齐。
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