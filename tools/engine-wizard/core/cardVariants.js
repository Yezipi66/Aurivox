'use strict'

// 一次接入多个形态：从一张基础名片派生出若干张模式名片。
// 派生名片只换身份与命令行入口，runtime、models、parameters 全部继承。
// 环境与权重因此仍留在原引擎目录，多张名片共用，不复制文件。
// 哪些模式值得单独接成名片由人在前端勾选，本模块不替人判断。

const { validateId } = require('./save')

function fail (code, error, at) {
  const out = { ok: false, code, error }
  if (at !== undefined) out.at = at
  return out
}

function copy (value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 由基础名片派生一张模式名片。
 * variant：{ id, label?, argv, requires_reference_audio? }
 * argv 必须由调用方给全；子命令写在哪里由向导既有的 writeSubcommand 决定，
 * 本模块不猜入口结构。
 */
function deriveVariantManifest (base, variant) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return fail('BAD_BASE', 'A base manifest object is required.', undefined)
  }
  const baseId = typeof base.id === 'string' ? base.id.trim() : ''
  if (!baseId || validateId(baseId)) {
    return fail('BAD_BASE_ID', 'The base manifest needs a valid id.')
  }
  if (!variant || typeof variant !== 'object' || Array.isArray(variant)) {
    return fail('BAD_VARIANT', 'Each variant needs an id and an argv array.')
  }

  const id = typeof variant.id === 'string' ? variant.id.trim() : ''
  const idErr = validateId(id)
  if (idErr) return fail('BAD_ID', idErr)
  if (id === baseId) {
    return fail('SAME_ID', 'A variant id must differ from the base id.')
  }

  const argv = variant.argv
  if (!Array.isArray(argv) || argv.length === 0 ||
      argv.some((w) => typeof w !== 'string' || !w.trim())) {
    return fail('BAD_ARGV', 'A variant argv must be a non-empty array of words.')
  }
  if (variant.requires_reference_audio !== undefined &&
      typeof variant.requires_reference_audio !== 'boolean') {
    return fail('BAD_CAPABILITY', 'requires_reference_audio must be a boolean when provided.')
  }

  const out = copy(base)
  out.id = id
  out.label = typeof variant.label === 'string' && variant.label.trim()
    ? variant.label.trim()
    : `${base.label || baseId} (${id})`
  out.call = { ...(out.call || {}), argv: argv.map((w) => String(w).trim()) }
  if (variant.requires_reference_audio !== undefined) {
    out.capabilities = {
      ...(out.capabilities || {}),
      requires_reference_audio: variant.requires_reference_audio,
    }
  }
  return { ok: true, id, manifest: out }
}

/**
 * 整批派生。任一候选不合法时整批不返回名片，避免只写出一部分。
 */
function buildVariantCards (base, variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return fail('NO_VARIANTS', 'Select at least one variant to generate.')
  }
  const cards = []
  const seen = new Set()
  for (let i = 0; i < variants.length; i++) {
    const r = deriveVariantManifest(base, variants[i])
    if (!r.ok) return { ...r, at: i }
    if (seen.has(r.id)) return fail('DUP_ID', `Duplicate variant id: ${r.id}`, i)
    seen.add(r.id)
    cards.push({ id: r.id, manifest: r.manifest })
  }
  return { ok: true, cards }
}

/** 共用的环境与权重位置，给批量结果做核对用。 */
function sharedAssets (base) {
  const r = (base && base.runtime) || {}
  const c = (base && base.call) || {}
  return {
    python: r.python || null,
    checkpoints: r.checkpoints || null,
    entry: r.entry || null,
    cwd: c.cwd || null,
  }
}

module.exports = { deriveVariantManifest, buildVariantCards, sharedAssets }
