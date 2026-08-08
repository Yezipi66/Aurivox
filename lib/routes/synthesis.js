// ===========================
//  ROUTES: Synthesis (/api/generate, /v1/audio/speech)
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");
const { HttpError, asyncHandler, RawResponse } = require("../http/http");
const { remapOverridesForSegment } = require("../util/positionOverrides");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { APP_DIR, ASSETS_DIR, ASSETS_ROOT, AUDIO_FORMATS, baseVoiceReg, buildTtsPayload, checkFfmpeg, clientError, computeSegmentBounds, concatWavFiles, fs, genAssetDir, genBaseName, generateOneSegment, gsvPost, gsvStream, isBaseVoice, loadAdvancedParams, loadVoices, newGenId, normSource, path, pathResolver, pickBestCkpt, recipeStore, requireApiKey, resolveRefPath, resolveSeed, splitJapaneseText, switchModels, toPcm16Wav, transcodeAudio, wavDurationSec, withGenerationLock, writeGenMeta } = ctx;

  // In-flight registry hook (1.0.7): register each synthesis request with the
  // graceful-shutdown coordinator so a shutdown WAITS for it to finish. A request
  // may opt into being aborted on shutdown by sending `interrupted:true` (mainly
  // meaningful for streaming, where aborting the client also aborts the engine).
  // /tts errors used to be discarded by clientError() and the browser only got
  // "Segment 0 failed". This broker is a local workbench, so return a bounded,
  // path-redacted engine diagnosis that the user can actually act on.
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

  const registerInflight = (req, res) => {
    const b = req.body || {};
    const interruptible = b.interrupted === true || b.interrupted === "true";
    // An AbortController lets a shutdown / `interrupted:true` cancel the in-flight
    // UPSTREAM engine request (not merely the client socket) for NON-streaming
    // synthesis. The service threads req._aurivoxSignal into gsvPost so the engine
    // call is actually torn down; streaming already aborts via res 'close'.
    const ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
    req._aurivoxSignal = ac ? ac.signal : null;
    const ss = ctx.shutdownState;
    if (!ss || typeof ss.register !== "function") return () => {};
    const entry = { interruptible, abort: () => {
      try { if (ac) ac.abort(); } catch (_) {}
      try { res.destroy(); } catch (_) {}
    } };
    return ss.register(entry);
  };

  // Stage-2 service: computes the generation result and returns a JSON-
  // serialisable payload (sent as 200), or throws HttpError for any error
  // response. It never touches req/res - the thin handler below adapts it.
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

  // Thin handler: delegates to the service and lets asyncHandler translate
  // HttpError -> res.status().json() and any other throw -> 500 via clientError,
  // preserving the original handler's `res.status(500).json({ error: clientError(err) })`.
  router.post("/api/generate", requireApiKey, asyncHandler(
    async (req, res) => { const done = registerInflight(req, res); try { return await generateService(req); } finally { done(); } },
    (err) => { console.error("[ERROR] Generate failed:", err.message); return clientError(err); },
  ));

  // Stage-2 service: resolves the voice, runs synthesis under the generation
  // lock and returns a RawResponse (binary audio) on success, or throws
  // HttpError for any error exit. It never touches req/res - the thin handler
  // below adapts it via asyncHandler.
  const speechService = async (req, res) => {
  const { model, voice: voiceSel, input, response_format, speed, language } = req.body || {};
  // OpenAI-compat (1.0.7): accept the standard `model` field as the voice/model
  // selector so ids from GET /v1/models are usable directly as `model`. The
  // broker's native `voice` field still wins when both are supplied.
  const voice = voiceSel || model;
  // Streaming extension (OPTIONAL, non-OpenAI-core): when `stream` is true (or the
  // engine's `streaming_mode` is a truthy value) the broker relays the engine's
  // chunked audio to the client with the FIRST bytes flushed as soon as the engine
  // produces them, instead of buffering the whole clip. Non-streaming callers are
  // unaffected. Streaming uses engine-native containers only (wav/ogg) so it needs
  // no ffmpeg. By default a streamed request is NOT archived to disk (there is no
  // finished file to point a meta.json at); pass `persist: true` to tee the stream
  // to the broker output root and write meta.json after the stream completes.
  const _sm = (req.body || {}).streaming_mode;
  const wantStream = ((req.body || {}).stream === true) || (_sm !== undefined && _sm !== false && _sm !== 0 && _sm !== "0");
  const wantPersist = (req.body || {}).persist === true;
  if (!voice) throw new HttpError(400, "Missing 'model' (or 'voice') field");
  if (!input) throw new HttpError(400, "Missing 'input' field");
  if (input.length > 5000) throw new HttpError(400, "Input too long (max 5000 chars)");

  let voices;
  try { voices = loadVoices(); } catch (err) { throw new HttpError(500, clientError(err, "voices.json error")); }

  const advParams = loadAdvancedParams();

  // Resolve the `voice` field into a concrete inference config. Two paths:
  //   1. `voice` = "role/name"  → recipe (P5). Uses the recipe's pinned models,
  //      reference audio/text and params. Distribution-stable and reproducible.
  //   2. `voice` = "role"       → whole-voice (legacy). Auto-picks the best
  //      checkpoint + first matched segment. Standard OpenAI clients keep working.
  let role = voice;
  let refAudio = "";
  let refText = "";
  let gptModel = "";
  let sovitsModel = "";
  let recipeId = null;
  let textLang = "";
  let promptLang = "";
  // Set when text_lang resolves to "auto" purely by fallback (no request field,
  // no recipe.language, no asset language) - surfaced to the downstream caller
  // as an X-Language-Warning header so an auto-multilingual read is never silent.
  let langWarning = null;
  let recParams = null;
  let recipeSchemaVersion = 1; // set on the recipe path; aux paths resolve with it.

  // Aurivox extension (OPTIONAL, non-OpenAI): a `language` field pins the READING
  // language per request at the HIGHEST priority - above recipe.language and asset
  // language (request > recipe > asset > auto). It's purely additive: OpenAI
  // clients that never send it behave exactly as before. The supported set is
  // intentionally narrow (zh/ja/en/auto, plus the internal auto_zh_ja multilingual
  // mode); anything else - including yue/ko, currently unmaintained - is NOT a hard
  // error: it falls back to 'auto' and surfaces an X-Language-Warning so the caller
  // is told the requested language isn't supported. Only `text_lang` is affected;
  // prompt_lang stays decoupled (it tracks the reference audio, not the target text).
  // Accept BOTH the friendly bare codes and the canonical engine text_lang modes,
  // normalising to the concrete value GPT-SoVITS expects. Bare zh/ja mean "force
  // this language" -> all_zh/all_ja (the same mapping the UI uses; see
  // VOICE_TO_TARGET / TARGET_LANG_OPTIONS in web/src/lib/format.jsx). recipe.language
  // is stored in the canonical form (e.g. "all_ja"), so a recipe-card curl that
  // echoes the recipe's own language round-trips cleanly instead of being wrongly
  // treated as unsupported.
  const SPEECH_LANG_ALIAS = {
    zh: "all_zh", all_zh: "all_zh",
    yue: "all_yue", all_yue: "all_yue",
    ja: "all_ja", all_ja: "all_ja",
    en: "en",
    ko: "all_ko", all_ko: "all_ko",
    auto: "auto",
    auto_zh_ja_yue: "auto_zh_ja_yue",
    auto_zh_ja: "auto_zh_ja_yue",
  };
  let reqLang = null;            // normalized engine text_lang the caller pinned
  let reqLangUnsupported = null; // original token when it maps to nothing supported
  if (language != null && String(language).trim() !== "") {
    const norm = String(language).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(SPEECH_LANG_ALIAS, norm)) {
      reqLang = SPEECH_LANG_ALIAS[norm];
    } else {
      reqLang = "auto";
      reqLangUnsupported = String(language).trim();
    }
  }

  if (typeof voice === "string" && voice.includes("/")) {
    // --- Recipe path ---
    const recipe = recipeStore.resolveVoice(voice);
    if (!recipe) throw new HttpError(404, `Unknown recipe voice: ${voice}`);
    role = recipe.role;
    recipeId = recipe.id;
    // The built-in Base model voice (__base__) is not in voices.json; resolve it
    // in-memory (mirrors the whole-voice path) so a recipe pinned to the母模
    // pretrained weights is callable downstream instead of 404-ing here.
    const voiceReg = voices[role] || (isBaseVoice(role) ? baseVoiceReg() : null);
    if (!voiceReg) throw new HttpError(404, `Recipe '${voice}' references unknown voice '${role}'`);

    // v3 version-aware resolution. Legacy (v<=2) string paths resolve against
    // APP_DIR exactly as before; v3 { base, path } objects resolve asset-relative
    // (ASSETS_ROOT, containment-checked) or as an explicit external absolute path.
    // A managed-path escape (traversal / symlink) is a hard 400, not a not-found.
    const schemaVersion = recipe.schema_version || 1;
    recipeSchemaVersion = schemaVersion;
    const rref = pathResolver.resolveManagedRef(recipe.reference_audio, { schemaVersion });
    if (!rref.ok) throw new HttpError(400, `Recipe '${voice}' reference_audio rejected: ${rref.error}`, { code: rref.code });
    refAudio = rref.path;
    refText = recipe.reference_text || "";
    if (!refAudio || !fs.existsSync(refAudio)) {
      throw new HttpError(400, `Recipe '${voice}' reference_audio not found: ${JSON.stringify(recipe.reference_audio)}`);
    }
    if (!refText) throw new HttpError(400, `Recipe '${voice}' has no reference_text`);

    // Pinned models. A missing pinned file means the voice was retrained/pruned -
    // the Broker page re-binds it.
    for (const [label, field] of [["gpt_ckpt", "gpt_ckpt"], ["sovits_pth", "sovits_pth"]]) {
      const val = recipe[field];
      if (!val) continue;
      const rm = pathResolver.resolveManagedRef(val, { schemaVersion });
      if (!rm.ok) throw new HttpError(400, `Recipe '${voice}' ${label} rejected: ${rm.error}`, { code: rm.code });
      if (rm.path && !fs.existsSync(rm.path)) {
        throw new HttpError(400, `Recipe '${voice}' pinned ${label} is missing (re-bind it in the Broker page): ${rm.path}`);
      }
      if (label === "gpt_ckpt") gptModel = rm.path; else sovitsModel = rm.path;
    }
    // Language defense stack: request.language (highest, explicit per-request) >
    // recipe.language (export-time choice) > asset language > "auto". A blank
    // recipe.language means "don't freeze the language" - follow the asset, and
    // ultimately auto.
    if (reqLang) {
      textLang = reqLang;
      if (reqLangUnsupported) {
        langWarning = `Requested language '${reqLangUnsupported}' is not supported (supported: zh, yue, ja, en, ko, auto - or canonical all_zh/all_yue/all_ja/all_ko/auto_zh_ja_yue); text_lang fell back to 'auto'.`;
        console.warn(`[broker] ${langWarning}`);
      }
    } else {
      textLang = recipe.language || voiceReg.text_lang || voiceReg.language || "auto";
    }
    // prompt_lang is DECOUPLED from text_lang: the reference audio's language is
    // a fixed property of the asset (first truth, set at fine-tune time), never
    // the recipe's target-text mode. It only affects reference-text tokenisation.
    promptLang = voiceReg.prompt_lang || voiceReg.language || "auto";
    if (!reqLang && !recipe.language && !voiceReg.text_lang && !voiceReg.language) {
      langWarning = `Recipe '${voice}' pins no language and its asset has none; text_lang defaulted to 'auto' (multilingual). Shared Han-character reading may vary - set a language on the recipe for deterministic output.`;
      console.warn(`[broker] ${langWarning}`);
    }
    recParams = recipe.params || {};
  } else {
    // --- Whole-voice path (legacy, unchanged behavior) ---
    const voiceReg = voices[voice];
    if (!voiceReg) throw new HttpError(404, `Unknown voice: ${voice}`);

    const segPath = path.join(ASSETS_DIR, voice, "segments.json");
    if (!fs.existsSync(segPath)) throw new HttpError(400, `Voice '${voice}' has no segments.json. Scan assets first.`);
    try {
      const segData = JSON.parse(fs.readFileSync(segPath, "utf-8"));
      const first = (segData.segments || []).find(s => s.matched && (s.audio || s.audio_path || s.audio_filename));
      if (first) {
        const raw = first.audio || first.audio_path || first.audio_filename;
        refAudio = resolveRefPath(raw);
        refText = first.text || "";
      }
    } catch (e) { throw new HttpError(500, `Failed to read segments.json: ${e.message}`); }

    if (!refAudio) throw new HttpError(400, `Voice '${voice}' has no matched reference audio in segments.json`);
    if (!fs.existsSync(refAudio)) throw new HttpError(400, `reference_audio file not found: ${refAudio}`);
    if (!refText) throw new HttpError(400, `Voice '${voice}' has no reference_text in segments.json`);

    const metaPath = path.join(ASSETS_DIR, voice, "meta.json");
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      const ckpts = meta?.assets?.checkpoints || {};
      if ((ckpts.gpt || []).length > 0) gptModel = (pickBestCkpt(ckpts.gpt) || {}).path || "";
      if ((ckpts.sovits || []).length > 0) sovitsModel = (pickBestCkpt(ckpts.sovits) || {}).path || "";
    }
    // request.language (highest) > asset text_lang/language > "auto".
    if (reqLang) {
      textLang = reqLang;
      if (reqLangUnsupported) {
        langWarning = `Requested language '${reqLangUnsupported}' is not supported (supported: zh, yue, ja, en, ko, auto - or canonical all_zh/all_yue/all_ja/all_ko/auto_zh_ja_yue); text_lang fell back to 'auto'.`;
        console.warn(`[broker] ${langWarning}`);
      }
    } else {
      textLang = voiceReg.text_lang || voiceReg.language || "auto";
    }
    promptLang = voiceReg.prompt_lang || voiceReg.language || "auto";
    if (!reqLang && !voiceReg.text_lang && !voiceReg.language) {
      langWarning = `Voice '${voice}' has no language metadata; text_lang defaulted to 'auto' (multilingual). Shared Han-character reading may vary.`;
      console.warn(`[broker] ${langWarning}`);
    }
  }

  return await withGenerationLock(async () => {
        // Recipe params take precedence over the global advanced-params defaults;
        // missing fields (older v1 recipes) fall back to advParams (PA-3).
        const rp = recParams || {};
        const pick = (k, adv) => (rp[k] != null ? rp[k] : adv);

        // Auxiliary references (PA): use the SAME schema-aware managed-path
        // resolver as the main reference (Patch #11 R1/R2 fix). A recipe's aux
        // entries may be legacy strings OR v3 { base, path } objects; the old
        // resolveRefPath() only handled strings and threw on objects, so a v3
        // recipe carrying aux refs would 500 at distribution. Resolve each and
        // keep only the ones that still exist on this machine.
        let auxResolved = [];
        if (Array.isArray(rp.aux_ref_audio_paths)) {
          auxResolved = rp.aux_ref_audio_paths
            .map((p) => {
              const r = pathResolver.resolveManagedRef(p, { schemaVersion: recipeSchemaVersion });
              return r.ok ? r.path : "";
            })
            .filter((p) => p && fs.existsSync(p));
        }

        const cfg = {
          gpt_model: gptModel,
          sovits_model: sovitsModel,
          reference_audio: refAudio,
          reference_text: refText,
          text_lang: textLang,
          prompt_lang: promptLang,
          temperature: pick("temperature", advParams.temperature),
          top_k: pick("top_k", advParams.top_k),
          top_p: pick("top_p", advParams.top_p),
          repetition_penalty: pick("repetition_penalty", advParams.repetition_penalty),
          text_split_method: rp.text_split_method || advParams.text_split_method,
          speed_factor: (rp.speed != null ? rp.speed : (speed || 1.0)),
          // Reproducibility: resolve -1/random into a concrete seed so the engine uses a
          // known value and the archived meta records it (audit + reproducibility).
          seed: resolveSeed(pick("seed", advParams.seed)),
          // Advanced group - pinned by the recipe when present (PA).
          sample_steps: pick("sample_steps", advParams.sample_steps),
          if_sr: rp.if_sr != null ? rp.if_sr : advParams.if_sr,
          batch_size: pick("batch_size", advParams.batch_size),
          batch_threshold: pick("batch_threshold", advParams.batch_threshold),
          split_bucket: rp.split_bucket != null ? rp.split_bucket : advParams.split_bucket,
          fragment_interval: pick("fragment_interval", advParams.fragment_interval),
          parallel_infer: rp.parallel_infer != null ? rp.parallel_infer : advParams.parallel_infer,
        };
        if (auxResolved.length > 0) cfg.aux_ref_audio_paths = auxResolved;
        // Auto (Multilingual): kana-free CJK fallback = voice metadata language.
        if (cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja") {
          // Kana-free CJK fallback must be a CONCRETE base language. The asset
          // language may now be "auto" (honest default), which is NOT a valid
          // base lang - coerce anything non-concrete to "zh".
          const _albRaw = String(rp.auto_base_lang || voiceReg.language || voiceReg.text_lang || "zh").toLowerCase();
          cfg.auto_base_lang = ["zh", "ja", "yue", "ko", "en"].includes(_albRaw) ? _albRaw : "zh";
        }
        // Pinned pronunciation overrides ride along (PA-1). When the recipe also
        // pins reverse-language readings for forced Han characters (#4), merge them
        // into the nested {lang:{word:[readings]}} form the engine understands.
        {
          const base = (rp.pron_overrides && typeof rp.pron_overrides === "object" &&
            !Array.isArray(rp.pron_overrides) && Object.keys(rp.pron_overrides).length > 0)
            ? rp.pron_overrides : null;
          const langOv = (rp.lang_overrides && typeof rp.lang_overrides === "object") ? rp.lang_overrides : {};
          const readings = (rp.han_readings && typeof rp.han_readings === "object") ? rp.han_readings : {};
          const reverse = {};
          for (const ch of Object.keys(readings)) {
            const r = String(readings[ch] == null ? "" : readings[ch]).trim();
            const lng = langOv[ch];
            if (r && lng) { (reverse[lng] = reverse[lng] || {})[ch] = [r]; }
          }
          const hasReverse = Object.keys(reverse).length > 0;
          if (hasReverse) {
            const baseLang = String(cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja"
              ? (cfg.auto_base_lang || "zh")
              : (cfg.text_lang || "zh")).toLowerCase()
              .replace("all_", "").replace("auto_", "").replace("auto", "zh") || "zh";
            const merged = { ...reverse };
            if (base) merged[baseLang] = { ...(merged[baseLang] || {}), ...base };
            cfg.pron_overrides = merged;
          } else if (base) {
            cfg.pron_overrides = base;
          }
        }
        // Per-character language overrides ride along verbatim when pinned.
        if (rp.lang_overrides && typeof rp.lang_overrides === "object" &&
            Object.keys(rp.lang_overrides).length > 0) {
          cfg.lang_overrides = rp.lang_overrides;
        }

        await switchModels(cfg);

        // --- Streaming branch (low-latency chunked relay) --------------------
        // Kept ABOVE the ffmpeg/format contract below because streaming uses only
        // engine-native containers (wav/ogg), which need no ffmpeg. We hold the
        // generation lock for the full duration of the relay (this callback stays
        // pending until the pipe finishes), so a concurrent model switch can't race.
        if (wantStream) {
          // Engine-native streamable containers. Non-streamable formats (mp3/opus/
          // aac/flac) would require piping WAV through ffmpeg chunk-by-chunk; that
          // is out of scope here, so we reject with a clear pointer instead of
          // silently degrading the container.
          const STREAM_FORMATS = { wav: { mime: "audio/wav", ext: "wav" }, ogg: { mime: "audio/ogg", ext: "ogg" } };
          const sfmtReq = (typeof response_format === "string" ? response_format.toLowerCase().trim() : "") || "wav";
          const sfmt = STREAM_FORMATS[sfmtReq];
          if (!sfmt) {
            throw new HttpError(400, {
              message: `Streaming supports only response_format 'wav' or 'ogg' (engine-native, no ffmpeg). ` +
                `'${sfmtReq}' cannot be streamed; request it without stream=true to get a transcoded file, or use 'ogg' for best browser playback.`,
              type: "invalid_request_error",
              code: "stream_format_unsupported",
              param: "response_format",
              requested_format: sfmtReq,
              supported_streaming_formats: ["wav", "ogg"],
            });
          }

          const spayload = buildTtsPayload(input, cfg);
          for (const key of ["sample_steps", "if_sr"]) {
            if (cfg[key] !== undefined) spayload[key] = cfg[key];
          }
          spayload.speed_factor = cfg.speed_factor;
          spayload.media_type = sfmt.ext;   // wav | ogg
          spayload.streaming_mode = 2;       // engine chunked streaming
          for (const k of ["overlap_length", "min_chunk_length"]) {
            const v = (req.body || {})[k];
            if (v !== undefined && v !== null && v !== "") {
              const n = parseInt(v, 10);
              if (Number.isInteger(n)) spayload[k] = n;
            }
          }

          const up = await gsvStream("/tts", spayload);
          // Upstream error (e.g. check_params 400) arrives as a NON-streamed JSON
          // body; drain it and surface as an HttpError (headers not yet sent).
          if (up.statusCode >= 400) {
            const chunks = [];
            for await (const c of up.stream) chunks.push(c);
            const body = Buffer.concat(chunks).toString();
            throw new HttpError(502, `GPT-SoVITS /tts streaming failed (${up.statusCode}): ${body.slice(0, 500)}`);
          }

          // Optional archive: tee the live stream to a file and stamp meta after it
          // finishes flushing. Failure to archive never breaks the live stream.
          let fileStream = null;
          let genId = null;
          let audioName = null;
          let audioUrl = null;
          if (wantPersist) {
            try {
              genId = newGenId();
              audioName = `audio.${sfmt.ext}`;
              audioUrl = `/outputs/broker/${genId}/${audioName}`;
              const dir = genAssetDir(genId, "broker");
              fs.mkdirSync(dir, { recursive: true });
              fileStream = fs.createWriteStream(path.join(dir, audioName));
            } catch (e) {
              console.error("[broker] stream archive setup failed:", e.message);
              fileStream = null;
            }
          }

          // Response headers (streamed: chunked, no Content-Length; inline so a
          // browser <audio> can start playing mid-download for 'ogg').
          res.status(200);
          res.set("Content-Type", sfmt.mime);
          res.set("Content-Disposition", `inline; filename="${(recipeId || role).replace(/[^a-zA-Z0-9_-]/g, "_")}_stream.${sfmt.ext}"`);
          res.set("Cache-Control", "no-cache, no-store");
          res.set("X-Voice-Id", role);
          res.set("X-Audio-Format", sfmt.ext);
          res.set("X-Text-Lang", cfg.text_lang);
          res.set("X-Streaming", "true");
          if (langWarning) res.set("X-Language-Warning", String(langWarning).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim());
          if (wantPersist && audioUrl) res.set("X-Output-Url", audioUrl);
          if (recipeId) res.set("X-Recipe-Id", recipeId);

          await new Promise((resolve, reject) => {
            let settled = false;
            let ended = false; // engine finished cleanly (distinguish from client abort)
            const done = (err) => {
              if (settled) return; settled = true;
              if (err) reject(err); else resolve();
            };
            up.stream.pipe(res);                 // client relay (auto-ends res)
            if (fileStream) up.stream.pipe(fileStream); // archive tee
            up.stream.on("end", () => {
              ended = true;
              if (fileStream) {
                fileStream.on("finish", () => {
                  try {
                    writeGenMeta(genId, {
                      id: genId, source: "broker", createdAt: Date.now(),
                      voice: role, voiceLabel: recipeId || voice, text: input, lang: cfg.text_lang,
                      gpt: genBaseName(cfg.gpt_model) || "\u2014", sovits: genBaseName(cfg.sovits_model) || "\u2014",
                      gpt_model: cfg.gpt_model, sovits_model: cfg.sovits_model,
                      ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
                      recipe_id: recipeId, model: model || null,
                      seed: cfg.seed, streamed: true,
                      segments: 1, audio_url: audioUrl,
                      files: [{ role: "single", name: audioName, url: audioUrl }],
                      status: "ok",
                    }, "broker");
                  } catch (e) { console.error("[broker] stream archive meta failed:", e.message); }
                });
              }
              done();
            });
            up.stream.on("error", (e) => {
              if (fileStream) fileStream.destroy();
              try { res.destroy(); } catch { /* best-effort */ }
              done(e);
            });
            // Client hung up BEFORE the engine finished: abort the upstream pull
            // and discard the partial archive. On a clean finish (ended=true) we
            // must NOT destroy fileStream here — that would truncate the file and
            // skip the meta write scheduled on its 'finish' event.
            res.on("close", () => {
              if (ended) { done(); return; }
              try { up.stream.destroy(); } catch { /* best-effort */ }
              if (fileStream) fileStream.destroy();
              done();
            });
          });
          // Response already fully written; nothing for asyncHandler to send.
          return undefined;
        }
        // --- end streaming branch --------------------------------------------

        // PH: resolve the requested response_format. The engine always renders
        // WAV; non-wav formats are transcoded below via ffmpeg. Unknown formats
        // are rejected (OpenAI does the same).
        const reqFmt = (typeof response_format === "string" ? response_format.toLowerCase().trim() : "") || "wav";
        if (!AUDIO_FORMATS[reqFmt]) {
          throw new HttpError(400, `Unsupported response_format '${response_format}'. Supported: ${Object.keys(AUDIO_FORMATS).join(", ")}.`);
        }
        let fmt = reqFmt;
        let formatNotice = null;
        // Strictly honor the caller's format contract. A non-WAV format requires
        // transcoding the engine's WAV through ffmpeg; if ffmpeg isn't installed
        // we must NOT silently ship WAV under a different Content-Type - that
        // breaks the contract the upstream explicitly requested. Reject instead,
        // and point the caller at the bundled ffmpeg provisioner.
        if (fmt !== "wav" && !checkFfmpeg()) {
          throw new HttpError(400, {
            message: `This broker cannot deliver '${reqFmt}' audio: ffmpeg is not installed on the server, and '${reqFmt}' requires transcoding from WAV. ` +
              `Provision the bundled ffmpeg by running tools/deploy/download_ffmpeg.py (installs vendor/ffmpeg/<platform>/), then restart the broker. ` +
              `Otherwise request response_format="wav", which needs no ffmpeg.`,
            type: "invalid_request_error",
            code: "ffmpeg_unavailable",
            param: "response_format",
            requested_format: reqFmt,
            supported_without_ffmpeg: ["wav"],
          });
        }

        const payload = buildTtsPayload(input, cfg);
        // aux resolved inside buildTtsPayload (Patch #11) - not re-injected here.
        for (const key of ["sample_steps", "if_sr"]) {
          if (cfg[key] !== undefined) payload[key] = cfg[key];
        }
        payload.speed_factor = cfg.speed_factor;
        // The engine only speaks WAV; transcoding happens broker-side.
        payload.media_type = "wav";

        const ttsRes = await gsvPost("/tts", payload, { signal: req._aurivoxSignal });
        if (ttsRes.statusCode >= 400) throw new HttpError(502, `GPT-SoVITS /tts failed (${ttsRes.statusCode}): ${ttsRes.body.toString()}`);

        const wavBytes = ttsRes.body;
        if (!wavBytes || wavBytes.length === 0) throw new HttpError(502, "GPT-SoVITS returned empty audio");

        // Transcode WAV → requested format when needed (ffmpeg confirmed above).
        // If transcoding fails we do NOT silently downgrade to WAV - that would
        // violate the format contract the caller requested. Surface the failure.
        let audioBytes = wavBytes;
        if (fmt !== "wav") {
          try {
            audioBytes = transcodeAudio(wavBytes, fmt);
          } catch (e) {
            console.error(`[broker] transcode to ${fmt} failed:`, e.message);
            throw new HttpError(500, {
              message: `Failed to transcode the generated audio to '${fmt}' via ffmpeg: ${e.message}. ` +
                `Verify the bundled ffmpeg build supports the '${fmt}' encoder (reinstall via tools/deploy/download_ffmpeg.py), ` +
                `or request response_format="wav".`,
              type: "server_error",
              code: "transcode_failed",
              param: "response_format",
              requested_format: fmt,
            });
          }
        }
        const mediaType = AUDIO_FORMATS[fmt].mime;

        // Persist to the broker output root (P3): every distributed call is
        // archived as a genId folder with meta.json (source=broker, recipe_id).
        const genId = newGenId();
        const ext = AUDIO_FORMATS[fmt].ext;
        const audioName = `audio.${ext}`;
        const audioUrl = `/outputs/broker/${genId}/${audioName}`;
        try {
          const dir = genAssetDir(genId, "broker");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, audioName), audioBytes);
          writeGenMeta(genId, {
            id: genId, source: "broker", createdAt: Date.now(),
            voice: role, voiceLabel: recipeId || voice, text: input, lang: cfg.text_lang,
            gpt: genBaseName(cfg.gpt_model) || "\u2014", sovits: genBaseName(cfg.sovits_model) || "\u2014",
            gpt_model: cfg.gpt_model, sovits_model: cfg.sovits_model,
            ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
            recipe_id: recipeId, model: model || null,
            seed: cfg.seed,
            segments: 1, audio_url: audioUrl,
            files: [{ role: "single", name: audioName, url: audioUrl }],
            status: "ok",
          }, "broker");
        } catch (e) { console.error("[broker] failed to archive output:", e.message); }

        const filename = `${(recipeId || role).replace(/[^a-zA-Z0-9_-]/g, "_")}_${genId}.${ext}`;
        // Build the response descriptor (headers in the original insertion order)
        // and return it; the thin handler / asyncHandler sends the binary body.
        const headers = {
          "Content-Type": mediaType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Voice-Id": role,
          "X-Audio-Format": fmt,
          "X-Text-Lang": cfg.text_lang,
        };
        // Defense line 4/6: never silently multilingual-read a language-less asset.
        // HTTP header values must be latin1-safe; a warning message carrying any
        // non-ASCII character (e.g. an em dash) would make res.setHeader throw
        // ERR_INVALID_CHAR and turn a successful synthesis into a 500. Coerce the
        // message to printable ASCII so the header can never break the response.
        if (langWarning) headers["X-Language-Warning"] = String(langWarning).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
        // (Retained for forward-compat; the broker no longer degrades formats,
        // so formatNotice is normally null and no notice header is emitted.)
        if (formatNotice) headers["X-Audio-Format-Notice"] = formatNotice;
        if (recipeId) headers["X-Recipe-Id"] = recipeId;
        return new RawResponse({ headers, body: audioBytes });
    });
  };

  // Thin handler: delegates to the service. asyncHandler translates a returned
  // RawResponse -> res.set(headers).send(body), HttpError -> res.status().json(),
  // and any other throw -> 500 via clientError, preserving the original outer
  // catch's `res.status(500).json({ error: clientError(err) })`.
  router.post("/v1/audio/speech", requireApiKey, asyncHandler(
    async (req, res) => { const done = registerInflight(req, res); try { return await speechService(req, res); } finally { done(); } },
    (err) => { console.error("[ERROR] /v1/audio/speech failed:", err.message); return clientError(err); },
  ));

  // ── OpenAI-compatible model listing (1.0.7) ──────────────────────
  // GET /v1/models and /v1/models/:model — advertise the callable TTS "models" so
  // standard OpenAI clients (which probe /v1/models on connect) don't treat the
  // broker as unreachable. Every entry is tagged as a TTS model (owned_by
  // "aurivox-tts", task "tts"). The ids are exactly what /v1/audio/speech accepts
  // as its `voice`: recipe ids ("role/name", the recommended reproducible form),
  // bare voice roles, and the built-in Base model.
  const listTtsModels = () => {
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set();
    const models = [];
    const push = (id) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      models.push({ id, object: "model", created, owned_by: "aurivox-tts", task: "tts" });
    };
    try { for (const r of recipeStore.list({})) push(r.id); } catch (_) {}
    try { for (const v of Object.keys(loadVoices() || {})) push(v); } catch (_) {}
    try { if (typeof ctx.BASE_VOICE_ID === "string") push(ctx.BASE_VOICE_ID); } catch (_) {}
    return models;
  };

  router.get("/v1/models", requireApiKey, asyncHandler(async () => ({
    object: "list",
    data: listTtsModels(),
  })));

  // Wildcard (not :model) so recipe ids containing "/" (role/name) are captured
  // in full via req.params[0]; Express 4's :param can't span a slash.
  router.get("/v1/models/*", requireApiKey, asyncHandler(async (req) => {
    const id = req.params[0];
    const found = listTtsModels().find((m) => m.id === id);
    if (!found) throw new HttpError(404, { message: `Model '${id}' not found`,
      type: "invalid_request_error", code: "model_not_found", param: "model" });
    return found;
  }));

  return router;
};
