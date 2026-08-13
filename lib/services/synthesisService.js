// ===========================
//  SERVICE: Legacy synthesis (FLOW-CORE-003B)
// ===========================
// Pure service extraction from routes/synthesis.js. It receives a request-like
// object with `body` and returns a JSON-serialisable result. It never touches
// Express req/res; the route remains the HTTP adapter.

const { HttpError } = require("../http/http");
const { remapOverridesForSegment } = require("../util/positionOverrides");

module.exports = function createSynthesisService(ctx) {
  const { baseVoiceReg, buildTtsPayload, clientError, computeSegmentBounds, concatWavFiles, fs, genAssetDir, genBaseName, generateOneSegment, isBaseVoice, loadVoices, newGenId, normSource, path, resolveSeed, splitJapaneseText, switchModels, toPcm16Wav, wavDurationSec, withGenerationLock, writeGenMeta } = ctx;

const synthesisFailureDetail = (err) => {
  let message = String((err && err.message) || err || "Unknown inference error");
  const upstream = message.match(/GPT-SoVITS \/tts failed \(\d+\):\s*([\s\S]*)$/);
  if (upstream) {
    try {
      const parsed = JSON.parse(upstream[1]);
      message = String(parsed.detail || parsed.message || parsed.error || upstream[1]);
    } catch { message = upstream[1]; }
  }
  // Avoid sending machine-specific absolute paths while preserving the actual
  // exception type/message. Keep the response small even for Python tracebacks.
  message = message.replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:[^\s"']+\/){2,}[^\s"']+/g, "[path]");
  return message.replace(/\s+/g, " ").trim().slice(0, 600) || "Unknown inference error";
};

const generateService = async (req) => {
const {
  voice, text, format, split, max_chars, concat, silence_ms,
  ref_audio, reference_text, aux_ref_audio_paths,
  temperature, top_k, top_p, repetition_penalty,
  text_split_method, speed_factor, seed,
  gpt_model, sovits_model, text_lang, prompt_lang,
  batch_size, batch_threshold, split_bucket,
  fragment_interval, parallel_infer,
  sample_steps, if_sr, super_sampling,
  media_type, streaming_mode,
  overlap_length, min_chunk_length,
  source, voice_label,
  pron_overrides, auto_base_lang, lang_overrides,
  engine_batch,
} = req.body || {};
if (!voice) throw new HttpError(400, "Missing 'voice' field");
if (!text) throw new HttpError(400, "Missing 'text' field");
if (text.length > 5000) throw new HttpError(400, "Text too long (max 5000 chars)");

// Validate voice exists (registration check only)
let voices;
try { voices = loadVoices(); } catch (err) { throw new HttpError(500, clientError(err, "voices.json error")); }
// The built-in Base model voice is not in voices.json; resolve it in-memory so
// zero-shot inference on the pretrained weights works without a fine-tuned asset.
const voiceReg = voices[voice] || (isBaseVoice(voice) ? baseVoiceReg() : null);
if (!voiceReg) throw new HttpError(404, `Unknown voice: ${voice}`);

// Build config from frontend-passed values (not from voices.json)
const cfg = {
  id: voice,
  voiceId: voice,
  gpt_model: gpt_model || "",
  sovits_model: sovits_model || "",
  reference_audio: ref_audio || "",
  reference_text: reference_text || "",
  aux_ref_audio_paths: aux_ref_audio_paths || [],
  text_lang: text_lang || voiceReg.text_lang || voiceReg.language || "auto",
  prompt_lang: prompt_lang || voiceReg.prompt_lang || voiceReg.language || "auto",
  temperature: temperature !== undefined ? parseFloat(temperature) : 1.0,
  top_k: top_k !== undefined ? parseInt(top_k, 10) : 15,
  top_p: top_p !== undefined ? parseFloat(top_p) : 1.0,
  repetition_penalty: repetition_penalty !== undefined ? parseFloat(repetition_penalty) : 1.35,
  text_split_method: text_split_method || "cut5",
  speed_factor: speed_factor !== undefined ? parseFloat(speed_factor) : 1.0,
  seed: resolveSeed(seed),
  batch_size: batch_size !== undefined ? parseInt(batch_size, 10) : undefined,
  batch_threshold: batch_threshold !== undefined ? parseFloat(batch_threshold) : undefined,
  split_bucket: split_bucket !== undefined ? !!split_bucket : undefined,
  fragment_interval: fragment_interval !== undefined ? parseFloat(fragment_interval) : undefined,
  parallel_infer: parallel_infer !== undefined ? !!parallel_infer : undefined,
  sample_steps: sample_steps !== undefined ? parseInt(sample_steps, 10) : undefined,
  if_sr: if_sr !== undefined ? !!if_sr : undefined,
  media_type: media_type || undefined,
  streaming_mode: streaming_mode !== undefined ? !!streaming_mode : undefined,
  overlap_length: overlap_length !== undefined ? parseInt(overlap_length, 10) : undefined,
  min_chunk_length: min_chunk_length !== undefined ? parseInt(min_chunk_length, 10) : undefined,
  // 读音校对（task6）：本次合成的词粒度读音覆盖，仅在非空对象时透传给引擎
  pron_overrides: (pron_overrides && typeof pron_overrides === "object" && !Array.isArray(pron_overrides) && Object.keys(pron_overrides).length) ? pron_overrides : undefined,
  // Per-character language overrides for shared Han characters ({substring -> lang}).
  lang_overrides: (lang_overrides && typeof lang_overrides === "object" && !Array.isArray(lang_overrides) && Object.keys(lang_overrides).length) ? lang_overrides : undefined,
};
// Auto (Multilingual): kana-free CJK fallback — normalise through the same
// concrete-set gate as speechService so `auto` / blank always resolves to a
// valid _ML_BASE_LANGS member (default "zh"), matching the engine's _norm_base_lang.
if (cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja") {
    const _albRaw = String(auto_base_lang || voiceReg.language || voiceReg.text_lang || "zh").toLowerCase();
    cfg.auto_base_lang = ["zh", "ja", "yue", "ko", "en"].includes(_albRaw) ? _albRaw : "zh";
}

// Resolve the reference once before model switching. The engine strictly needs
// 3–10 seconds; previously an invalid slice reached /tts and was collapsed by
// the UI into the misleading generic "Segment 0 failed" message.
const resolvedReference = buildTtsPayload("", cfg);
cfg.reference_audio = resolvedReference.ref_audio_path;
cfg.reference_text = resolvedReference.prompt_text;
if (!cfg.reference_audio || !fs.existsSync(cfg.reference_audio)) {
  throw new HttpError(400, "Reference audio is missing. Select an existing 3–10 second reference clip before generating.");
}
if (/\.wav$/i.test(cfg.reference_audio) && typeof wavDurationSec === "function") {
  const seconds = wavDurationSec(cfg.reference_audio);
  if (seconds > 0 && (seconds < 3 || seconds > 10)) {
    throw new HttpError(400, `Reference audio is ${seconds.toFixed(1)}s; GPT-SoVITS requires a 3–10s reference clip. Choose another slice before generating.`);
  }
}

const shouldSplit = split !== false;
const shouldConcat = concat !== false;
// A-1 "engine batch" mode (1.0.6): instead of the broker splitting the text and
// synthesising each segment SEQUENTIALLY (one /tts call per segment), hand the
// WHOLE text to the engine in a single /tts call so the engine splits it (by
// text_split_method) and runs those chunks through the model in PARALLEL batches
// (batch_size / parallel_infer). This is the same mechanism the OpenAI
// /v1/audio/speech endpoint uses. Trade-off: the engine concatenates internally,
// so there are NO per-segment files (one audio.wav), and Node-side concat /
// silence_ms no longer apply (the engine's fragment_interval governs gaps).
const engineBatch = engine_batch === true || engine_batch === "true";
const softLimit = Math.max(10, parseInt(max_chars, 10) || 45);
const silenceMs = Math.min(2000, Math.max(0, parseInt(silence_ms, 10) || 300));
// Engine only returns WAV; format param is accepted for API compatibility but always produces wav
const mediaType = "wav";
const genId = newGenId();
const genSource = normSource(source);
const genDir = genAssetDir(genId, genSource);
fs.mkdirSync(genDir, { recursive: true });
const genUrlBase = `/outputs/${genSource}/${genId}`;
// Optional association back to a saved recipe (P3): the OpenAI endpoint and any
// recipe-driven generation stamp `recipe_id` so the Broker page + history can
// link an output to the recipe that produced it.
const genRecipeId = (req.body && typeof req.body.recipe_id === "string") ? req.body.recipe_id : null;
// Batch grouping: Compare Refs (and any future multi-output run) tags every
// member generation with a shared batch id, so a single "Generate All" is
// recorded as ONE comparison batch - you can see how many audios it produced
// and which reference each used, instead of a flat pile indistinguishable from
// one-off inference. Batches are reconstructed by grouping member meta.json
// (see GET /api/outputs/batches); no separate manifest file to drift out of sync.
const genBatch = (() => {
  const b = req.body || {};
  const id = (typeof b.batch_id === "string" && b.batch_id.trim()) ? b.batch_id.trim().slice(0, 80) : null;
  if (!id) return null;
  const toInt = (v) => (Number.isInteger(v) ? v : (parseInt(v, 10) || 0));
  return { id, seq: toInt(b.batch_seq), total: toInt(b.batch_total),
    label: (typeof b.batch_label === "string") ? b.batch_label.slice(0, 200) : "" };
})();
// The captured recipe (for Rerun) must NOT carry batch fields, or a rerun would
// silently re-join a stale batch. Strip them; batch lives only under meta.batch.
const { batch_id: _bid, batch_seq: _bseq, batch_total: _btot, batch_label: _blbl,
  ...recipeBody } = (req.body || {});
// Capture the resolved (engine-facing) auto fallback rather than the raw UI
// value. The Base model UI historically sent auto_base_lang="auto"; the
// engine correctly coerces that to zh, but storing the raw token made metadata
// look as if the engine had received an unresolved language.
const capturedRecipe = { ...recipeBody, seed: cfg.seed };
if (cfg.auto_base_lang) capturedRecipe.auto_base_lang = cfg.auto_base_lang;
// Shared audit fields; each branch adds split/concat/segments/audio_url/files.
const metaBase = {
  id: genId, source: genSource, createdAt: Date.now(),
  voice, voiceLabel: voice_label || voice, text, lang: cfg.text_lang,
  auto_base_lang: cfg.auto_base_lang || undefined,
  gpt: genBaseName(cfg.gpt_model) || "-",
  sovits: genBaseName(cfg.sovits_model) || "-",
  gpt_model: cfg.gpt_model, sovits_model: cfg.sovits_model,
  ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
  recipe_id: genRecipeId,
  // Batch membership (null for ordinary one-off generations).
  batch: genBatch,
  // Reproducibility: stamp the RESOLVED seed (never -1) into both the top-level audit
  // field and the captured recipe, so Rerun (which replays meta.recipe) reproduces the
  // exact audio instead of re-randomising.
  seed: cfg.seed,
  recipe: capturedRecipe, status: "ok",
};

return await withGenerationLock(async () => {
    await switchModels(cfg);

    // Single whole-text generation. Taken when: split is disabled, the text is
    // short enough, OR engine-batch mode is on (the engine does its own split +
    // parallel batching over the whole text in one call).
    if (!shouldSplit || engineBatch || text.length <= softLimit) {
      if (engineBatch) console.log(`[ENGINE-BATCH] whole text (${text.length} chars) -> single /tts call, engine splits+batches (batch_size=${cfg.batch_size ?? "default"})`);
      const audioBytes = toPcm16Wav(await generateOneSegment(text, cfg));
      fs.writeFileSync(path.join(genDir, "audio.wav"), audioBytes);
      const audioUrl = `${genUrlBase}/audio.wav`;
      writeGenMeta(genId, { ...metaBase, split: false, concat: false, segments: 1,
        engine_batch: engineBatch || undefined,
        audio_url: audioUrl,
        files: [{ role: "single", name: "audio.wav", url: audioUrl }] });
      console.log(`[OK] Generated: ${genId}/audio.wav (${audioBytes.length} bytes)`);
      return { ok: true, id: genId, voice, split: false, concat: false, engine_batch: engineBatch, audio_url: audioUrl, seed: cfg.seed };
    }

    // Split + generate
    const segments = splitJapaneseText(text, { softLimit, hardLimit: softLimit * 2 });
    console.log(`[SPLIT] ${text.length} chars -> ${segments.length} segments`);

    const segFiles = [];
    const segResults = [];
    let segmentSearchFrom = 0;

    for (let i = 0; i < segments.length; i++) {
      const segText = segments[i];
      // The UI stores @N positions against the FULL input text. Each broker
      // segment is a separate /tts request, so remap only the positions that
      // belong to this segment into local @0-based coordinates. Without this,
      // @0/@1 (for example a Yue override on "你好") would be reapplied to the
      // beginning of every later segment (e.g. "今日").
      const remapped = remapOverridesForSegment(cfg, text, segText, segmentSearchFrom);
      segmentSearchFrom = remapped.nextCodeUnit;
      const segmentCfg = remapped.cfg;
      console.log(`[SEG ${i}/${segments.length - 1}] "${segText.slice(0, 30)}..." (${segText.length} chars, source_offset=${remapped.segmentStart ?? 0})`);
      try {
        const audioBytes = toPcm16Wav(await generateOneSegment(segText, segmentCfg));
        const segName = `seg${String(i).padStart(3, "0")}.${mediaType}`;
        const segPath = path.join(genDir, segName);
        fs.writeFileSync(segPath, audioBytes);
        segFiles.push(segPath);
        segResults.push({ index: i, text: segText, source_start: remapped.segmentStart ?? 0, audio_url: `${genUrlBase}/${segName}` });
        console.log(`[OK] Segment ${i}: ${genId}/${segName} (${audioBytes.length} bytes)`);
      } catch (err) {
        console.error(`[FAIL] Segment ${i} failed: ${err.message}`);
        throw new HttpError(502, `Segment ${i} failed: ${synthesisFailureDetail(err)}`, {
          ok: false,
          segments: segResults,
        });
      }
    }

    if (!shouldConcat || segFiles.length === 1) {
      // No concatenation requested or only one segment
      const first = segResults[0];
      writeGenMeta(genId, { ...metaBase, split: true, concat: false, segments: segResults.length,
        audio_url: first.audio_url,
        files: segResults.map(s => ({ role: "segment", index: s.index, source_start: s.source_start, name: genBaseName(s.audio_url), url: s.audio_url })) });
      return {
        ok: true, id: genId, voice, split: true, concat: false,
        audio_url: first.audio_url,
        seed: cfg.seed,
        segments: segResults,
        warning: segFiles.length === 1 ? "Text fit in one segment; no concatenation needed" : undefined,
      };
    }

    // Concatenate
    const combinedName = `combined.${mediaType}`;
    const combinedPath = path.join(genDir, combinedName);

    try {
      const concatResult = await concatWavFiles(segFiles, combinedPath, silenceMs);
      const combinedSize = fs.statSync(combinedPath).size;
      console.log(`[OK] Combined: ${genId}/${combinedName} (${combinedSize} bytes, method: ${concatResult.method})`);

      const combinedUrl = `${genUrlBase}/${combinedName}`;
      // Segment-boundary offsets for the waveform preview's dividers.
      const { bounds: segBounds, duration: segDuration } = computeSegmentBounds(segFiles, silenceMs);
      const segResultsBounded = segResults.map((s, i) => ({ ...s, start: segBounds[i]?.start, end: segBounds[i]?.end }));
      writeGenMeta(genId, { ...metaBase, split: true, concat: true, segments: segResults.length,
        audio_url: combinedUrl, duration: segDuration, segment_bounds: segBounds,
        files: [{ role: "combined", name: combinedName, url: combinedUrl },
          ...segResults.map(s => ({ role: "segment", index: s.index, source_start: s.source_start, name: genBaseName(s.audio_url), url: s.audio_url }))] });

      return {
        ok: true, id: genId, voice, split: true, concat: true,
        audio_url: combinedUrl,
        seed: cfg.seed,
        silence_ms: silenceMs,
        concat_method: concatResult.method,
        duration: segDuration,
        segment_bounds: segBounds,
        segments: segResultsBounded,
      };
    } catch (err) {
      console.error(`[FAIL] Concatenation failed: ${err.message}`);
      throw new HttpError(
        500,
        clientError(err, "Audio concatenation failed"),
        {
          ok: false,
          segments: segResults,
          warning: "Segment files are still available for manual playback.",
        },
      );
    }
  });
};

  return { generateService };
};
