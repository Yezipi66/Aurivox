'use strict'

// 画布节点的合成适配器：把节点请求转成 broker 的合成调用，返回带磁盘路径与配方的音频对象。
// 引擎特有的部分都在这里，换一台 TTS 就是再写一个同样形状的适配器，engine.js 不必改。
// 引擎认得哪些参数由 engines/<id>/manifest.json 声明，本文件不持有那份表。
// 引擎节点必须自己指定 engine_id 与音色，本文件不替它挑默认引擎。

const nodePath = require('node:path')
const nodeFs = require('node:fs')

// 不在清单上的键会被拦下而不是丢掉：服务端本来就会忽略它，静默放行会让一个
// 拼错的参数名看起来像生效了。
const engineRegistry = require('../engines/registry')

function adapterError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

// split / concat / format 由平台定死：画布上一个节点 = 一段音频。让图里把 split
// 改回 true 的话，broker 会在背后再切一次，循环次数与实际产出的段数不一致。
// 因此这三个键也不会出现在画布的参数格子里（service.js 读这张表来隐藏）。
// 这是平台自己的职责划分，所以写在这里而不是名片里。
const RESERVED_PARAM_KEYS = Object.freeze(['split', 'concat', 'format'])

// 只转发名片声明过的参数，其余的键单独收起来交给调用方报错。
function pickKnown(params, manifest) {
  const allowed = (manifest && manifest.param_keys) || []
  const out = {}
  const unknown = []
  for (const [key, value] of Object.entries(params || {})) {
    // 平台自己拿主意的键：既不转发，也不当作「拼错了」报错。
    // 画布压根没给过填它们的地方，能走到这一行的只有手改过的图。
    if (RESERVED_PARAM_KEYS.includes(key)) continue
    if (allowed.includes(key)) out[key] = value
    else unknown.push(key)
  }
  return { known: out, unknown }
}

// 把 /outputs/<source>/<id>/audio.wav 换算成磁盘上的真实路径。
function urlToPath(url, outputRoot) {
  if (typeof url !== 'string' || !url.startsWith('/outputs/')) return null
  if (!outputRoot) return null
  const relative = url.slice('/outputs/'.length)
  if (relative.includes('..')) return null
  return nodePath.join(outputRoot, ...relative.split('/'))
}

/**
 * 造出引擎交给合成节点用的 synthesize 函数。
 * @param {Function} generateService 现有的 broker 合成服务，不改
 * @param {object} options.outputRoot /outputs/* 在磁盘上的位置
 * @param {string} options.defaultVoice 引擎节点没指定音色时用哪个
 */
function createSynthesizeAdapter(generateService, options = {}) {
  if (typeof generateService !== 'function') {
    throw adapterError('FG_ADAPTER_NO_SERVICE', '合成适配器需要一个真正的合成服务')
  }
  const outputRoot = options.outputRoot || null
  const fs = options.fs || nodeFs
  const defaultVoice = options.defaultVoice || null

  return async function synthesize(request) {
    const engine = request.engine || {}
    // 引擎节点必须写 engine_id（契约 §12）：不写就抛，不回落。
    // 回落会让忘了选引擎的图安静地出声，声音来自用户没指定过的那台；
    // 「本机只装了一台」只是巧合，装上第二台那天这条行为就换了含义。
    const engineId = engine.engine_id
    if (!engineId) {
      throw adapterError('FG_ENGINE_ID_MISSING',
        '引擎节点没有选择引擎（engine_id）：画布不再替你挑一台默认引擎，' +
        '请在引擎节点上选定要用哪台。本机装了哪些引擎见 GET /api/engines。')
    }
    // 装没装这个引擎问注册表（engines/<id>/manifest.json 在不在）。
    // 抛的仍是 FG_ENGINE_UNSUPPORTED，错误码对外不变。
    const manifest = engineRegistry.requireEngine(engineId)

    const voice = engine.voice || engine.voice_id || defaultVoice
    if (!voice) {
      throw adapterError('FG_ENGINE_NO_VOICE', '引擎节点未选择音色（voice），合成无法确定使用的音色')
    }
    if (!request.text || !String(request.text).trim()) {
      throw adapterError('FG_SYNTHESIZE_EMPTY_TEXT', '要合成的文字是空的')
    }

    const { known, unknown } = pickKnown(request.engine_params, manifest)
    if (unknown.length) {
      throw adapterError('FG_ENGINE_PARAM_UNKNOWN',
        `引擎参数中存在无法识别的名称：${unknown.join('、')}（名称拼写错误时该参数会被忽略，因此在此直接拦截）`,
        { unknown })
    }

    const refPath = request.reference_audio
      ? (request.reference_audio.path || request.reference_audio)
      : (engine.ref_audio || null)

    const body = Object.assign({
      // 一个节点一段音频：broker 不能背着画布再切一次，否则画布上的循环次数
      // 与实际产出的段数不一致。
      split: false,
      concat: false,
      format: request.format || 'wav',
    }, known, {
      voice,
      text: String(request.text),
      // engine_id 必须进 body：漏了它，画布上选了哪台都不影响请求发去哪，
      // 于是无论选谁，请求都发到同一台。
      engine_id: engineId,
      // 同一份参数再挂一份「按引擎分格」的形状，给启动前的非空校验用。
      // 平台只看这格空不空，不看里面有什么键、值对不对。
      engine_params: { [engineId]: known },
    })
    if (refPath) body.ref_audio = refPath
    if (request.seed !== null && request.seed !== undefined) body.seed = request.seed

    let result
    try {
      result = await generateService({ body })
    } catch (error) {
      throw adapterError('FG_SYNTHESIZE_FAILED',
        `合成执行失败：${(error && error.message) || error}`,
        { cause: error, voice, text_preview: String(request.text).slice(0, 24) })
    }

    const url = result && (result.audio_url
      || (Array.isArray(result.segments) && result.segments[0] && result.segments[0].audio_url))
    if (!url) {
      throw adapterError('FG_SYNTHESIZE_NO_AUDIO', '合成服务返回了结果，但里面没有音频地址', { result })
    }
    const filePath = urlToPath(url, outputRoot)
    if (filePath && !fs.existsSync(filePath)) {
      throw adapterError('FG_SYNTHESIZE_FILE_MISSING',
        `合成服务报告写入成功，但该文件不存在：${filePath}（可能原因：磁盘空间不足，或文件已被其他程序清理）`,
        { path: filePath })
    }

    // 配方随音频一起走：画布上的一个片段随时能自述来历，不必再去别处查。
    return {
      kind: 'audio',
      path: filePath,
      url,
      format: body.format,
      duration: result.duration || null,
      recipe: {
        engine_id: engineId,
        voice,
        text: String(request.text),
        seed: result.seed !== undefined ? result.seed : (body.seed ?? null),
        reference_audio: refPath || null,
        params: known,
        generation_id: result.id || null,
      },
    }
  }
}

/** 造出 concatAudio，复用 broker 自己的拼接，这样画布和生成页拼出的结果完全一致。 */
function createConcatAdapter(concatWavFiles, options = {}) {
  if (typeof concatWavFiles !== 'function') {
    throw adapterError('FG_ADAPTER_NO_CONCAT', '拼接适配器需要 concatWavFiles')
  }
  const fs = options.fs || nodeFs
  const outputDir = options.outputDir || null

  return async function concatAudio(audios, opts = {}) {
    const list = (audios || []).filter(Boolean)
    if (!list.length) throw adapterError('FG_CONCAT_EMPTY', '拼接节点没有收到任何音频')
    const paths = list.map((a, i) => {
      const p = a.path || a
      if (typeof p !== 'string') throw adapterError('FG_CONCAT_BAD_ITEM', `拼接节点收到的第 ${i + 1} 个东西不是音频`)
      if (!fs.existsSync(p)) {
        throw adapterError('FG_CONCAT_FILE_MISSING', `拼接时第 ${i + 1} 段音频文件不存在：${p}（运行前该文件仍可访问）`, { path: p })
      }
      return p
    })
    const dir = opts.dir || outputDir
    if (!dir) throw adapterError('FG_CONCAT_NO_DIR', '拼接节点不知道要把结果放哪儿')
    fs.mkdirSync(dir, { recursive: true })
    const target = nodePath.join(dir, `${opts.basename || 'concat'}_${Date.now()}.wav`)
    const outcome = await concatWavFiles(paths, target, Number(opts.silence_ms) || 0)
    return {
      kind: 'audio',
      path: target,
      format: 'wav',
      method: outcome && outcome.method,
      recipe: {
        made_of: list.map(a => (a.recipe ? a.recipe : null)),
        silence_ms: Number(opts.silence_ms) || 0,
      },
    }
  }
}

/**
 * 造出 saveVoice：把一次运行的设置写回成一个音色。
 * 写入走 broker 自己的音色存储，与 /api/voices 用的是同一套 loadVoices / saveVoices
 * 和那把锁，因此两个写入方不会互相穿插丢掉一条，字段也与 POST /api/voices 一致：
 * 平台里打不开的音色不算音色。
 */
function createSaveVoiceAdapter(ctx) {
  const { loadVoices, saveVoices, withVoicesLock, safeId, _backupVoicesUnlocked } = ctx || {}
  if (typeof loadVoices !== 'function' || typeof saveVoices !== 'function') return null

  return async function saveVoice(request) {
    const id = String(request?.id || '').trim()
    if (!id) throw adapterError('FG_VOICE_NO_ID', '未填写音色 ID，无法保存')
    if (typeof safeId === 'function' && !safeId(id)) {
      throw adapterError('FG_VOICE_BAD_ID', `音色 ID 不合法：${id}（仅允许字母、数字、下划线与连字符）`)
    }

    let saved = null
    const write = async () => {
      const voices = loadVoices()
      if (voices[id] && !request.overwrite) {
        throw adapterError('FG_VOICE_EXISTS', `音色 ${id} 已存在。如需覆盖，请在节点上启用「覆盖同名音色」。`)
      }
      if (typeof _backupVoicesUnlocked === 'function') await _backupVoicesUnlocked()
      const params = request.params || {}
      voices[id] = {
        display_name: request.display_name || id,
        language: request.language || 'auto',
        prompt_lang: request.language || 'auto',
        text_lang: request.language || 'auto',
        gpt_model: params.gpt_model || '',
        sovits_model: params.sovits_model || '',
        reference_audio: request.reference_audio || '',
        reference_text: params.reference_text || '',
        text_split_method: params.text_split_method || 'cut5',
        top_k: params.top_k ?? 15,
        top_p: params.top_p ?? 1.0,
        temperature: params.temperature ?? 1.0,
        repetition_penalty: params.repetition_penalty ?? 1.35,
      }
      saveVoices(voices)
      saved = voices[id]
    }

    if (typeof withVoicesLock === 'function') await withVoicesLock(write)
    else await write()

    return { id, voice: saved }
  }
}

module.exports = {
  RESERVED_PARAM_KEYS,
  createSynthesizeAdapter,
  createConcatAdapter,
  createSaveVoiceAdapter,
  // 不导出参数白名单：它现在只住在各引擎自己的 manifest.json 里，
  // 再留一个空壳导出，「参数白名单在哪」就又变成两个答案。
  urlToPath,
}
