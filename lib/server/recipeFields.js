// v3 recipe path classification.
// Rewrites the four managed fields on a recipe create/update body into
// structured { base, path } objects with field-aware external permissions.

const { normalizeModelPath, importCustomRefToAsset } = require("./paths");
const pathResolver = require("../pathResolver");

function classifyRecipeManagedFields(body, { targetV3, allowExternalModels, allowExternalAudio, role }) {
  if (!targetV3) {
    for (const key of ["gpt_ckpt", "sovits_pth"]) {
      if (body[key] != null && body[key] !== "") {
        const n = normalizeModelPath(body[key], { allowExternal: allowExternalModels });
        if (!n.ok) return { ok: false, error: `${key}: ${n.error}`, code: n.code, field: key };
        body[key] = n.value;
      }
    }
    return { ok: true };
  }
  const model = { field: "model", allowExternalModels, allowExternalAudio };
  const audio = { field: "audio", allowExternalModels, allowExternalAudio };
  if (role) {
    if (typeof body.reference_audio === "string") {
      body.reference_audio = importCustomRefToAsset(body.reference_audio, role);
    }
    if (body.params && Array.isArray(body.params.aux_ref_audio_paths)) {
      body.params.aux_ref_audio_paths = body.params.aux_ref_audio_paths
        .map((p) => (typeof p === "string" ? importCustomRefToAsset(p, role) : p));
    }
  }
  for (const [key, opts] of [["gpt_ckpt", model], ["sovits_pth", model], ["reference_audio", audio]]) {
    if (body[key] != null && body[key] !== "") {
      const c = pathResolver.classifyManagedPath(body[key], opts);
      if (!c.ok) return { ok: false, error: `${key}: ${c.error}`, code: c.code, field: key };
      body[key] = c.value;
    }
  }
  const aux = body.params && Array.isArray(body.params.aux_ref_audio_paths)
    ? body.params.aux_ref_audio_paths : null;
  if (aux) {
    const out = [];
    for (const p of aux) {
      if (p == null || p === "") continue;
      const c = pathResolver.classifyManagedPath(p, audio);
      if (!c.ok) return { ok: false, error: `aux_ref_audio_paths: ${c.error}`, code: c.code, field: "aux_ref_audio_paths" };
      out.push(c.value);
    }
    body.params.aux_ref_audio_paths = out;
  }
  return { ok: true };
}

module.exports = { classifyRecipeManagedFields };
