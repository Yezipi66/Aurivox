// Shared helpers for cross-asset model mixing (issue #3).
//
// The synthesis backend (/api/generate) already accepts arbitrary absolute
// gpt_model / sovits_model paths and forwards them verbatim to the engine's
// set_gpt_weights / set_sovits_weights. So "mix A's GPT with B's SoVITS" is
// purely a front-end capability: let the user pick each checkpoint from ANY
// asset, then send the two independent paths. These helpers centralise:
//   * deriving which asset a checkpoint path belongs to (for Rerun/restore), and
//   * lazily loading a given asset's published GPT / SoVITS checkpoint lists.
import { useState, useEffect } from 'react'
import { api } from './api'

// Canonical id of the built-in Base model, treated as a virtual asset in the
// cross-asset mix pickers (it has no folder on disk; its checkpoints are the
// pretrained weights synthesized by the backend).
export const BASE_VOICE_ID = '__base__'

// The built-in Base checkpoints live under the pretrained-weights root, not under
// assets/<id>/, so their paths carry these distinctive signatures. Used to tag a
// restored base selection back to __base__ so a base+asset mix survives reload.
const BASE_CKPT_RE = /(?:^|\/)(?:gsv-v2final|v2Pro)\/|(?:^|\/)s1bert25hz-|(?:^|\/)s2G(?:2333k|488k|v2Pro|v2ProPlus)\.pth$/

// Extract the owning asset id from a published checkpoint path, e.g.
//   ".../assets/<id>/gpt_checkpoints/<file>.ckpt" -> "<id>"
//   ".../assets/<id>/sovits_models/<file>.pth"    -> "<id>"
// Built-in Base checkpoints resolve to the virtual '__base__' id so a base-side
// selection is recognised as cross-asset. Returns '' for anything else
// (custom/broker paths).
export function assetIdFromCkptPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  const m = s.match(/(?:^|\/)assets\/([^/]+)\/(?:gpt_checkpoints|sovits_models)\//)
  if (m) return m[1]
  if (s && BASE_CKPT_RE.test(s)) return BASE_VOICE_ID
  return ''
}

// Fetch a single asset's checkpoint lists ({ gpt:[], sovits:[] }). Base voice is
// resolved through the same endpoint shape (/api/assets/__base__). Returns null
// while loading and never throws (empty lists on any error).
export function useAssetCheckpoints(voiceId) {
  const [ckpts, setCkpts] = useState({ gpt: [], sovits: [] })
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!voiceId) { setCkpts({ gpt: [], sovits: [] }); return }
    let cancelled = false
    setLoading(true)
    // Clear immediately so consumers see an empty list during the async load — this
    // lets "reconcile" effects guard on a non-empty list and avoid clobbering a
    // just-restored cross-asset selection while the new source is still loading.
    setCkpts({ gpt: [], sovits: [] })
    api(`/api/assets/${voiceId}`).then(r => {
      if (cancelled) return
      const c = (r.ok && r.data && r.data.ok && r.data.meta?.assets?.checkpoints) || {}
      setCkpts({ gpt: c.gpt || [], sovits: c.sovits || [] })
    }).catch(() => { if (!cancelled) setCkpts({ gpt: [], sovits: [] }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [voiceId])
  return { ckpts, loading }
}

// One-shot list of assets that have at least one published model, for the
// cross-asset mixing pickers. Each entry now carries the FULL checkpoint arrays
// so the grouped model dropdowns can render every model of every owning asset:
//   [{ voiceId, displayName, hasGpt, hasSovits, gpt:[...], sovits:[...] }].
export function useAssetsWithModels() {
  const [assets, setAssets] = useState([])
  useEffect(() => {
    let cancelled = false
    api('/api/assets/voices-with-models').then(r => {
      if (cancelled) return
      setAssets((r.ok && r.data && r.data.voices) ? r.data.voices : [])
    }).catch(() => { if (!cancelled) setAssets([]) })
    return () => { cancelled = true }
  }, [])
  return assets
}

// Build per-asset groups for the mix-mode dropdowns (rendered as <optgroup>s).
// Only assets that actually own a checkpoint of the given kind are included.
export function gptGroups(assets) {
  return (assets || [])
    .filter(a => a.hasGpt && (a.gpt || []).length)
    .map(a => ({ voiceId: a.voiceId, displayName: a.displayName || a.voiceId, items: a.gpt || [] }))
}
export function sovitsGroups(assets) {
  return (assets || [])
    .filter(a => a.hasSovits && (a.sovits || []).length)
    .map(a => ({ voiceId: a.voiceId, displayName: a.displayName || a.voiceId, items: a.sovits || [] }))
}
