'use strict'

// ---------------------------------------------------------------------------
//  Adapter — plug the node engine into the real synthesis service
// ---------------------------------------------------------------------------
// The engine deliberately knows nothing about GPT-SoVITS. It calls
// `ctx.synthesize({ text, engine, reference_audio, seed, engine_params })` and
// expects an audio object back. Everything engine-specific lives here.
//
// That is what makes "GPT-SoVITS 是起点而不是终点" mechanical rather than a
// slogan: a second TTS is a second adapter in this same shape, and not one line
// of engine.js changes.

const nodePath = require('node:path')
const nodeFs = require('node:fs')

// 引擎认得哪些参数，由引擎自己的 engines/<id>/manifest.json 声明，本文件
// 不再持有那张表 —— r12c 之前这里硬编码着 GPT-SoVITS 的 34 个键，意味着
// 「接第二个引擎」要改这个文件。现在它只问注册表。
//
// 不在清单上的键会被**拦下**而不是丢掉：服务端本来就会忽略它，静默放行
// 会让一个拼错的参数名看起来像生效了。
const engineRegistry = require('../engines/registry')

function adapterError(code, message, details = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, details)
  return error
}

function pickKnown(params, manifest) {
  const allowed = (manifest && manifest.param_keys) || []
  const out = {}
  const unknown = []
  for (const [key, value] of Object.entries(params || {})) {
    if (allowed.includes(key)) out[key] = value
    else unknown.push(key)
  }
  return { known: out, unknown }
}

// `/outputs/<source>/<id>/audio.wav` -> a real path on disk.
function urlToPath(url, outputRoot) {
  if (typeof url !== 'string' || !url.startsWith('/outputs/')) return null
  if (!outputRoot) return null
  const relative = url.slice('/outputs/'.length)
  if (relative.includes('..')) return null
  return nodePath.join(outputRoot, ...relative.split('/'))
}

/**
 * Build the `synthesize` function the engine hands to the合成 node.
 *
 * @param {Function} generateService  the existing broker service, unchanged
 * @param {object}   options.outputRoot  where /outputs/* lives on disk
 * @param {string}   options.defaultVoice  used when the engine node names none
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
    const engineId = engine.engine_id || 'gpt-sovits'
    // 装没装这个引擎，问注册表（engines/<id>/manifest.json 在不在）。
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
      // One node, one line: the broker must not re-split behind the graph's
      // back, or the loop count on the canvas stops matching reality.
      split: false,
      concat: false,
      format: request.format || 'wav',
    }, known, {
      voice,
      text: String(request.text),
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

    // The recipe travels WITH the audio. This is the "check recipe" the user
    // asked for: a clip on the canvas can always say what made it, without a
    // separate ledger to look it up in.
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

/**
 * Build the `concatAudio` function, reusing the broker's own concat so the
 * canvas and the generate page produce byte-identical joins.
 */
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
 * Build the `saveVoice` function: a run that produced something worth keeping
 * can write its settings back as a voice.
 *
 * The write goes through the broker's own voice store — the same loadVoices /
 * saveVoices / lock the voices route uses — so a voice created from the canvas
 * is indistinguishable from one created on the voices page, and two writers can
 * never interleave and lose one of the two entries.
 *
 * Field for field this matches POST /api/voices. Kept in step deliberately: a
 * voice that the rest of the Workbench cannot open is not a voice.
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
  createSynthesizeAdapter,
  createConcatAdapter,
  createSaveVoiceAdapter,
  // GPT_SOVITS_KEYS 于 r12c 移入 engines/gpt-sovits/manifest.json。
  // 全仓无人 require 它（删除前已确认），因此不留兼容导出 —— 留一个空壳
  // 会让「参数白名单在哪」重新变成两个答案。
  urlToPath,
}
