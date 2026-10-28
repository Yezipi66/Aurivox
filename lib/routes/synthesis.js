// 合成路由：/api/generate 与 /v1/audio/speech。共用 server.js 的作用域符号由 `ctx` 注入。
// 引擎由配方或请求指明，路由不替调用方挑：裸音色路径必须显式带 engine_id，否则 400。
// 参数与权重位全部问名片要，路由里不写死任何引擎名或位名。

const express = require("express");
const { HttpError, asyncHandler, RawResponse } = require("../http/http");
const createSynthesisService = require("../services/synthesisService");
const { toV4, flatParams } = require("../recipeView");
const { resolveEngineProfile: _resolveEngineProfile } = require("../engines/profile");
const { weightSummary } = require("../engines/weightSummary");
// meta.assets.models 这层结构只在 lib/assets/slotPicks.js 拆包。
const { pickSlotWeights } = require("../assets/slotPicks");
// 名片驱动的请求体组装：这条路由只问名片「你把这个概念叫什么」「你收不收这个键」。
const { engineKey, acceptsKey } = require("../engines/payload");
// 参数表只有一份（名片），补键/收键都走 lib/engines/paramTable.js。
const { applyEngineKnobs, coerceIncoming } = require("../engines/paramTable");
// 出错时点名的是真正出事的那台引擎，不是写死的 GPT-SoVITS。
const { upstreamFailure, emptyAudioFailure, isTransportError, transportFailure } = require("../engines/upstreamError");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const resolveEngineProfile = ctx.resolveEngineProfile || _resolveEngineProfile;
  const { APP_DIR, ASSETS_DIR, ASSETS_ROOT, AUDIO_FORMATS, baseVoiceReg, buildTtsPayload, checkFfmpeg, clientError, computeSegmentBounds, concatWavFiles, fs, genAssetDir, genBaseName, generateOneSegment, gsvPost, gsvStream, isBaseVoice, loadAdvancedParams, loadVoices, newGenId, normSource, path, pathResolver, pickBestCkpt, recipeStore, requireApiKey, resolveRefPath, resolveSeed, splitJapaneseText, switchModels, toPcm16Wav, transcodeAudio, wavDurationSec, withGenerationLock, writeGenMeta } = ctx;

  // 登记在途请求，供优雅关机协调器等待。请求带 `interrupted:true` 时允许关机中止
  // 它（流式才有意义：中止客户端连接的同时也中止引擎）。
  const registerInflight = (req, res) => {
    const b = req.body || {};
    const interruptible = b.interrupted === true || b.interrupted === "true";
    // AbortController 让关机或 `interrupted:true` 能取消在途的上游引擎请求（不只是客户端 socket），
    // 适用于非流式合成：service 把 req._aurivoxSignal 传进 gsvPost 才真的拆得掉。
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

  // 算好生成结果并返回可 JSON 序列化的负载（以 200 返回），出错抛 HttpError。不碰 req/res。
  const { generateService } = createSynthesisService(ctx);

  router.post("/api/generate", requireApiKey, asyncHandler(
    async (req, res) => { const done = registerInflight(req, res); try { return await generateService(req); } finally { done(); } },
    (err) => { console.error("[ERROR] Generate failed:", err.message); return clientError(err); },
  ));

  // 解析音色、在生成锁下跑合成，成功返回 RawResponse（二进制音频），出错抛 HttpError。
  const speechService = async (req, res) => {
  const { model, voice: voiceSel, input, response_format, speed, language, engine_id } = req.body || {};
  // OpenAI 兼容：标准 `model` 字段也当音色/模型选择器，这样 GET /v1/models 给出的 id
  // 可以直接当 `model` 用。两个都给了时以本 broker 原生的 `voice` 字段为准。
  const voice = voiceSel || model;
  // 流式扩展（可选，不属于 OpenAI 核心）：`stream` 为真（或引擎的 `streaming_mode` 是真值）时，
  // 把引擎的分块音频转发给客户端，引擎一产出就先冲第一批字节。非流式调用不受影响。
  // 流式只用引擎原生的容器（wav/ogg），所以不需要 ffmpeg；默认不落盘，传 `persist: true` 才 tee 到输出目录。
  const _sm = (req.body || {}).streaming_mode;
  const wantStream = ((req.body || {}).stream === true) || (_sm !== undefined && _sm !== false && _sm !== 0 && _sm !== "0");
  const wantPersist = (req.body || {}).persist === true;
  if (!voice) throw new HttpError(400, "Missing 'model' (or 'voice') field");
  if (typeof input !== "string" || input === "") {
    throw new HttpError(400, "Missing 'input' field", { code: "TEXT_REQUIRED" });
  }
  if (input.length > 5000) throw new HttpError(400, "Input too long (max 5000 chars)");

  let voices;
  try { voices = loadVoices(); } catch (err) { throw new HttpError(500, clientError(err, "voices.json error")); }

  // advanced_params 的读取挪到引擎解析之后：那份默认值
  // 只对被点名的那台引擎成立，提前读会拿到另一台的底座。
  // 把 `voice` 字段解析成一份具体的推理配置，两条路径：
  //  1. `voice` = "role/name" → 配方：用配方钉住的模型、参考音频/文本和参数。
  //  2. `voice` = "role" → 整音色（老路径）：自动挑最好的 checkpoint 加第一条匹配到的片段。
  let role = voice;
  let refAudio = "";
  let refText = "";
  // 一张按名片声明的参数名索引的表：{ <weight_slots[].param>: 路径 }。平台不认识 gpt / sovits
  // 这两个词，它只知道「名片说有几个位、每个位选中的那一份用哪个键发出去」。
  const slotPicks = {};
  let recipeId = null;
  let textLang = "";
  let promptLang = "";
  let langWarning = null;
  let recParams = null;
  let recipeSchemaVersion = 1; // 配方路径上设定；辅助参考路径按同一个版本解析。
  // 这次调用发给哪台引擎、带它的哪一格参数。配方路径上由配方自己说了算（v4 的 engine_id）；
  // 整音色路径由请求的 engine_id 说了算，缺了就 400。
  let callEngine = null;
  let callEngineParams = null;

  // Aurivox 扩展（可选，不属于 OpenAI）：`language` 字段以最高优先级钉住本次请求的朗读语言
  // （请求 > 配方 > 资产 > auto）。纯增量：不发它的 OpenAI 客户端行为完全不变。
  // 支持的语言就是下面这张表：zh / yue / ja / en / ko / auto，加上内部的
  // auto_zh_ja 多语模式；表里没有的退回 'auto' 并发 X-Language-Warning。
  // 只有 `text_lang` 受影响；prompt_lang 与它解耦。
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
  let reqLang = null;            // 调用方钉住的引擎 text_lang（已归一）
  let reqLangUnsupported = null; // 归一后落到空处的原始取值
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
    const recipe = recipeStore.resolveVoice(voice);
    if (!recipe) throw new HttpError(404, `Unknown recipe voice: ${voice}`);
    role = recipe.role;
    recipeId = recipe.id;
    // 内置底模音色（__base__）不在 voices.json 里，在内存里解析（同整音色路径），
    // 这样钉了母模预训练权重的配方在下游能调用，而不是在这里就 404。
    const voiceReg = voices[role] || (isBaseVoice(role) ? baseVoiceReg() : null);
    if (!voiceReg) throw new HttpError(404, `Recipe '${voice}' references unknown voice '${role}'`);
    // 按 schema 版本解析路径。v3 的 { base, path } 对象相对资产根解析（ASSETS_ROOT，带越界检查），
    // 旧版字符串路径照旧相对 APP_DIR 解析。受管路径越界是硬 400，不是 404。
    const schemaVersion = recipe.schema_version || 1;
    recipeSchemaVersion = schemaVersion;
    // 配方自己说去哪台引擎（v4）。配方没记引擎就是一份不完整的配方：不迁移、
    // 不标「引擎未知」、不替它挑一台，直接报错。
    // 名片读不出来也是 400，不回落：回落会把「名片写错」表现成「声音不对」。
    const _recipeEngineId = toV4(recipe).engine_id;
    if (!_recipeEngineId) {
      throw new HttpError(400,
        `Recipe '${voice}' does not say which engine to use. ` +
        `Open it once and pick an engine, then save.`,
        { code: "RECIPE_NO_ENGINE" });
    }
    let recipeEngine;
    try {
      recipeEngine = resolveEngineProfile(_recipeEngineId);
    } catch (err) {
      throw new HttpError(400, `Recipe '${voice}' engine unavailable: ${(err && err.message) || err}`);
    }
    // 配方路径上不需要再传 engine_id，配方自己就是闭合的调用目标。
    // 请求又指了一台不同的引擎时，这是两个来源打架，报错而不是「覆盖」：
    // 静默按配方走会丢掉调用方明确写下的字段，现象是「声音不对」；
    // 让请求赢也不行，配方钉的模型是那台引擎专有的，跟着换引擎会被 acceptsKey 滤掉。
    if (engine_id != null && String(engine_id).trim() !== "" && String(engine_id) !== recipeEngine.id) {
      throw new HttpError(400,
        `Recipe '${voice}' is pinned to engine '${recipeEngine.id}', but the request asked for '${engine_id}'. ` +
        `A recipe already carries its engine - drop 'engine_id', or call the voice directly with the engine you want.`);
    }
    const v4 = toV4(recipe);
    callEngine = recipeEngine;
    callEngineParams = (v4.engine_params && v4.engine_params[recipeEngine.id]) || null;

    const rref = pathResolver.resolveManagedRef(recipe.reference_audio, { schemaVersion });
    if (!rref.ok) throw new HttpError(400, `Recipe '${voice}' reference_audio rejected: ${rref.error}`, { code: rref.code });
    refAudio = rref.path;
    refText = recipe.reference_text || "";
    // 参考音频/参考文本不再无条件必填，改由名片说了算：有的引擎根本没有参考音频这个概念，
    // 有的有音频但不收参考文本。写死必填，这几类引擎的配方就永远无法保存或调用。
    if (recipeEngine.requires_reference_audio) {
      if (!refAudio || !fs.existsSync(refAudio)) {
        throw new HttpError(400, `Recipe '${voice}' reference_audio not found: ${JSON.stringify(recipe.reference_audio)}`);
      }
      if (!refText) throw new HttpError(400, `Recipe '${voice}' has no reference_text`);
    } else if (refAudio && !fs.existsSync(refAudio)) {
      // 名片说不需要，但配方里确实填了一个指不到文件的路径：这是配方坏了，不是引擎的事，照样拦。
      throw new HttpError(400, `Recipe '${voice}' reference_audio not found: ${JSON.stringify(recipe.reference_audio)}`);
    }
    for (const [label, field] of [["gpt_ckpt", "gpt_ckpt"], ["sovits_pth", "sovits_pth"]]) {
      const val = recipe[field];
      if (!val) continue;
      const rm = pathResolver.resolveManagedRef(val, { schemaVersion });
      if (!rm.ok) throw new HttpError(400, `Recipe '${voice}' ${label} rejected: ${rm.error}`, { code: rm.code });
      if (rm.path && !fs.existsSync(rm.path)) {
        throw new HttpError(400, `Recipe '${voice}' pinned ${label} is missing (re-bind it in the Broker page): ${rm.path}`);
      }
      if (label === "gpt_ckpt") slotPicks.gpt_model = rm.path; else slotPicks.sovits_model = rm.path;
    }
    // 语言优先级：请求的 language（最高，逐次显式指定）> recipe.language（导出时的选择）
    // > 资产语言 > "auto"。配方里的语言留空表示「不冻结语言」。
    if (reqLang) {
      textLang = reqLang;
      if (reqLangUnsupported) {
        langWarning = `Requested language '${reqLangUnsupported}' is not supported (supported: zh, yue, ja, en, ko, auto - or canonical all_zh/all_yue/all_ja/all_ko/auto_zh_ja_yue); text_lang fell back to 'auto'.`;
        console.warn(`[broker] ${langWarning}`);
      }
    } else {
      textLang = recipe.language || voiceReg.text_lang || voiceReg.language || "auto";
    }
    // prompt_lang 与 text_lang 解耦：参考音频的语言是资产的固有属性（精调时定下），
    // 不是配方的目标文本模式。它只影响参考文本的切分。
    promptLang = voiceReg.prompt_lang || voiceReg.language || "auto";
    if (!reqLang && !recipe.language && !voiceReg.text_lang && !voiceReg.language) {
      langWarning = `Recipe '${voice}' pins no language and its asset has none; text_lang defaulted to 'auto' (multilingual). Shared Han-character reading may vary - set a language on the recipe for deterministic output.`;
      console.warn(`[broker] ${langWarning}`);
    }
    // v4 读时视图：通用格子（speed/seed）+ 本引擎格子，合成一张平表。
    // 下面 withGenerationLock 里那一堆 pick(k, adv) 的读法一个字都不用改。
    recParams = flatParams(v4);
  } else {
    const voiceReg = voices[voice];
    if (!voiceReg) throw new HttpError(404, `Unknown voice: ${voice}`);

    // 裸音色名没有任何地方写着「去哪台引擎」，静默回落到某台引擎等于替调用方做了一个
    // 他不知道的选择，所以缺 engine_id 就报 400。
    // 这一条故意放在 404 之后：查无此音色要报 404，顺序反了会把人指向无关的方向。
    if (engine_id == null || String(engine_id).trim() === "") {
      throw new HttpError(400,
        `Missing 'engine_id'. Calling a voice by its bare name ('${voice}') no longer picks an engine for you - ` +
        `say which engine to use, or call a recipe ('${voice}/<recipe>') which carries its own engine. ` +
        `GET /api/engines lists what this server has.`);
    }
    // 名片解析不了就 400，不回落：与配方路径同一条理由，回落会把「引擎名写错」表现成「声音不对」。
    try {
      callEngine = resolveEngineProfile(String(engine_id).trim());
    } catch (err) {
      throw new HttpError(400, `engine_id '${engine_id}' unavailable: ${(err && err.message) || err}`);
    }

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
      // 权重不许按引擎名写死：slotFromMeta(meta, "gpt-sovits", "gpt") 那种写法只认一台引擎，
      // 装第二台引擎的用户，模型明明扫进了 meta.assets.models[<那台>]，这条路一眼都不看。
      // 现在三样东西全从名片来：哪台引擎 = callEngine.id，有几个位 =
      // callEngine.weight_slots[].name，用哪个键发出去 = callEngine.weight_slots[].param。
      // 没有 param 的位不发（名片没写 = 这台引擎运行中换不了权重）：悄悄发一个没人读的键
      // 是撒谎，比不发更糟。
      Object.assign(slotPicks, pickSlotWeights(callEngine, meta, pickBestCkpt));
    }
    // 语言优先级：请求的 language（最高，逐次显式指定）> 资产语言 > "auto"。
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

  // 到这里 callEngine 必须已经有值：配方路径由配方给，整音色路径由请求给（缺了已经 400）。
  // 万一有人加了第三条分支忘了设 callEngine，堆栈会指向 buildTtsPayload 内部，
  // 所以这里直接报 500，不回落到默认引擎。
  if (!callEngine) {
    throw new HttpError(500,
      "internal: no engine resolved for this request. Both paths (recipe / bare voice) are supposed to " +
      "set one before this point - a new code path was added without picking an engine.");
  }

  return await withGenerationLock(async () => {
        const advParams = loadAdvancedParams(callEngine.id);
        const rp = recParams || {};
        const pick = (k, adv) => (rp[k] != null ? rp[k] : adv);

        // 辅助参考音频：与主参考用同一个懂 schema 的受管路径解析器。配方里的辅助项可能是
        // 旧版字符串，也可能是 v3 的 { base, path } 对象；resolveRefPath() 只认字符串。
        let auxResolved = [];
        if (Array.isArray(rp.aux_ref_audio_paths)) {
          auxResolved = rp.aux_ref_audio_paths
            .map((p) => {
              const r = pathResolver.resolveManagedRef(p, { schemaVersion: recipeSchemaVersion });
              return r.ok ? r.path : "";
            })
            .filter((p) => p && fs.existsSync(p));
        }

        // 引擎旋钮：配方里钉了就用配方的，没钉就用 advanced_params 里的。
        // 这里不逐个列键名：列出来就成了名片之外的第二份参数表，少列一个，用户在高级
        // 设置里拧的那一格在「按配方分发」这条路上就静默失效（症状是「同一个配方，
        // webui 和分发出来的声音不一样」，而没有任何一条测试会红）。
        // 循环放在前面、专门字段放在后面：speed_factor 也有自己的来源，顺序反了会吃掉语速。
        const engineKnobs = {};
        const knobProfile = callEngine;
        for (const entry of (knobProfile.param_schema || [])) {
          const k = entry.name;
          // 「挑一个东西」那两种（下拉 / 文件）用 ||：空串视同没填，
          // 与 text_split_method 那行、与前端 paramsToSend 对空路径不发是同一个意思。
          // 老名字 enum / path 一起认。其余（数字 / 勾选 / 文本）用 != null
          // （false / 0 / "" 都是有效值）。
          const picky = entry.type === "select" || entry.type === "enum" ||
            entry.type === "file" || entry.type === "path";
          engineKnobs[k] = picky
            ? (rp[k] || advParams[k])
            : (rp[k] != null ? rp[k] : advParams[k]);
        }

        const cfg = {
          ...engineKnobs,
          // 名片声明的每个权重位各按自己的 param 名挂上。放在 engineKnobs 之后，
          // 选中的权重才压过高级设置里的同名值。
          ...slotPicks,
          reference_audio: refAudio,
          reference_text: refText,
          text_lang: textLang,
          prompt_lang: promptLang,
          speed_factor: (rp.speed != null ? rp.speed : (speed || 1.0)),
          seed: resolveSeed(pick("seed", advParams.seed)),
        };
        if (auxResolved.length > 0) cfg.aux_ref_audio_paths = auxResolved;
        if (callEngineParams) cfg.engine_params = callEngineParams;
        if (cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja") {
          // 无假名的 CJK 回落必须落在具体的基础语言上。资产语言可能是 "auto"
          // （诚实的默认），那不是合法基础语言：非具体的一律归到 "zh"。
          const _albRaw = String(rp.auto_base_lang || voiceReg.language || voiceReg.text_lang || "zh").toLowerCase();
          cfg.auto_base_lang = ["zh", "ja", "yue", "ko", "en"].includes(_albRaw) ? _albRaw : "zh";
        }
        // 配方钉住的读音覆盖随请求带过去，合并成引擎认的嵌套 {lang:{word:[readings]}} 形式。
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
        if (rp.lang_overrides && typeof rp.lang_overrides === "object" &&
            Object.keys(rp.lang_overrides).length > 0) {
          cfg.lang_overrides = rp.lang_overrides;
        }

        await switchModels(cfg, callEngine);

        // 流式分支（低延迟分块转发）。放在 ffmpeg/格式契约之上：流式只用引擎原生的
        // 容器（wav/ogg），不需要 ffmpeg。
        if (wantStream) {
          // 引擎原生的可流式容器。不能流的格式要把 WAV 一块块过 ffmpeg，那不在这里做：
          // 直接报错并说明替代做法，而不是悄悄降级容器。
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

          const sProfile = callEngine;
          const spayload = buildTtsPayload(input, cfg, sProfile);
          // 这几处一律问名片要键名。名片没有这个概念就不发：硬塞过去，宽松的引擎静默忽略、
          // 严格的引擎当场 400。
          applyEngineKnobs(spayload, sProfile, cfg);
          // 本次请求可以临时顶掉任何一个引擎旋钮。放行清单不许按键名写死：只放行两个写死的键
          // 会让别的键在 body 里填了就被无声丢掉（又一份写死的清单）。
          for (const entry of (sProfile.param_schema || [])) {
            if (!acceptsKey(sProfile, entry.name)) continue;
            const v = coerceIncoming(entry, (req.body || {})[entry.name]);
            if (v !== undefined) spayload[entry.name] = v;
          }
          const _kSpeed = engineKey(sProfile, "speed");
          if (_kSpeed && cfg.speed_factor !== undefined) spayload[_kSpeed] = cfg.speed_factor;
          const _kMedia = engineKey(sProfile, "media_type");
          if (_kMedia) spayload[_kMedia] = sfmt.ext;        // wav 或 ogg
          const _kStream = engineKey(sProfile, "streaming");
          if (_kStream) spayload[_kStream] = 2;             // 引擎的分块流式

          // 必须把地址带上：gsvStream("/tts", spayload) 不带地址就等于永远发给默认那台引擎，
          // 配方明明写了 engine_id，请求却打到别的地址上。
          // 传输层失败在这里也要点名。
          let up;
          try {
            up = await gsvStream("/tts", spayload, 0,
              { baseUrl: sProfile.base_url, reqTimeout: sProfile.timeout_ms });
          } catch (err) {
            if (isTransportError(err)) {
              throw new HttpError(502,
                transportFailure(sProfile, err, { baseUrl: sProfile.base_url }).message);
            }
            throw err;
          }
          // 上游错误（例如 check_params 400）以非流式 JSON 体到达：把它读干，在响应头还没发出去时转成 HttpError。
          if (up.statusCode >= 400) {
            const chunks = [];
            for await (const c of up.stream) chunks.push(c);
            const body = Buffer.concat(chunks).toString();
            throw new HttpError(502,
              upstreamFailure(sProfile, up.statusCode, body.slice(0, 500), { streaming: true }).message);
          }

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
            let ended = false; // 引擎正常结束（与客户端断开区分开）
            const done = (err) => {
              if (settled) return; settled = true;
              if (err) reject(err); else resolve();
            };
            up.stream.pipe(res);                 // 转发给客户端（结束时自动结束 res）
            if (fileStream) up.stream.pipe(fileStream); // 同时落一份归档
            up.stream.on("end", () => {
              ended = true;
              if (fileStream) {
                fileStream.on("finish", () => {
                  try {
                    writeGenMeta(genId, {
                      id: genId, source: "broker", createdAt: Date.now(),
                      voice: role, voiceLabel: recipeId || voice, text: input, lang: cfg.text_lang,
                      // 位名与位数按名片记。
                      engine_id: callEngine.id,
                      engine_label: callEngine.label || callEngine.id,
                      weights: weightSummary(callEngine.weight_slots, cfg),
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
              try { res.destroy(); } catch { /* 尽力而为 */ }
              done(e);
            });
            // 客户端在引擎执行完之前就断开：中止上游拉取并丢掉未完成的归档。引擎正常结束时
            // （ended=true）绝不能在这里销毁 fileStream：那会截断文件，还跳过 meta 写入。
            res.on("close", () => {
              if (ended) { done(); return; }
              try { up.stream.destroy(); } catch { /* 尽力而为 */ }
              if (fileStream) fileStream.destroy();
              done();
            });
          });
          return undefined;
        }

        const reqFmt = (typeof response_format === "string" ? response_format.toLowerCase().trim() : "") || "wav";
        if (!AUDIO_FORMATS[reqFmt]) {
          throw new HttpError(400, `Unsupported response_format '${response_format}'. Supported: ${Object.keys(AUDIO_FORMATS).join(", ")}.`);
        }
        let fmt = reqFmt;
        let formatNotice = null;
        // 严格遵守调用方要的格式。非 WAV 格式要把引擎的 WAV 过一遍 ffmpeg；服务器没装 ffmpeg
        // 时绝不能悄悄按别的 Content-Type 送 WAV：那违反了调用方明确要求的格式契约。
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

        const nProfile = callEngine;
        const payload = buildTtsPayload(input, cfg, nProfile);
        applyEngineKnobs(payload, nProfile, cfg);
        const _nSpeed = engineKey(nProfile, "speed");
        if (_nSpeed && cfg.speed_factor !== undefined) payload[_nSpeed] = cfg.speed_factor;
        const _nMedia = engineKey(nProfile, "media_type");
        if (_nMedia) payload[_nMedia] = "wav";

        // 这里也必须带地址，否则配方选的引擎在运输层被丢掉；非流式这一支也要接住传输层失败。
        let ttsRes;
        try {
          ttsRes = await gsvPost("/tts", payload,
            { signal: req._aurivoxSignal, baseUrl: nProfile.base_url, reqTimeout: nProfile.timeout_ms });
        } catch (err) {
          if (isTransportError(err)) {
            throw new HttpError(502,
              transportFailure(nProfile, err, { baseUrl: nProfile.base_url }).message);
          }
          throw err;
        }
        if (ttsRes.statusCode >= 400) {
          throw new HttpError(502, upstreamFailure(nProfile, ttsRes.statusCode, ttsRes.body.toString()).message);
        }

        const wavBytes = ttsRes.body;
        if (!wavBytes || wavBytes.length === 0) throw new HttpError(502, emptyAudioFailure(nProfile).message);

        // 需要时把 WAV 转成请求的格式（上面已确认 ffmpeg 可用）。转码失败绝不悄悄降级成 WAV。
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

        // 落盘到 broker 输出目录：每次分发的调用都归档成一个 genId 目录，里面有 meta.json。
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
            engine_id: callEngine.id,
            engine_label: callEngine.label || callEngine.id,
            weights: weightSummary(callEngine.weight_slots, cfg),
            ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
            recipe_id: recipeId, model: model || null,
            seed: cfg.seed,
            segments: 1, audio_url: audioUrl,
            files: [{ role: "single", name: audioName, url: audioUrl }],
            status: "ok",
          }, "broker");
        } catch (e) { console.error("[broker] failed to archive output:", e.message); }

        const filename = `${(recipeId || role).replace(/[^a-zA-Z0-9_-]/g, "_")}_${genId}.${ext}`;
        // 组装响应描述（响应头保持既有的插入顺序）并返回，由薄 handler 发送二进制体。
        const headers = {
          "Content-Type": mediaType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Voice-Id": role,
          "X-Audio-Format": fmt,
          "X-Text-Lang": cfg.text_lang,
        };
        // 绝不让没有语言信息的资产被静默地按多语种读。HTTP 响应头的值必须 latin1 安全：
        // 警告文案带任何非 ASCII 字符都会让 res.setHeader 抛 ERR_INVALID_CHAR，把合成变成 500。
        if (langWarning) headers["X-Language-Warning"] = String(langWarning).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
        // broker 不降级格式，所以 formatNotice 通常是 null；这个头留给以后用。
        if (formatNotice) headers["X-Audio-Format-Notice"] = formatNotice;
        if (recipeId) headers["X-Recipe-Id"] = recipeId;
        return new RawResponse({ headers, body: audioBytes });
    });
  };

  // 薄 handler：转交给 service。asyncHandler 把返回的 RawResponse 翻译成
  // res.set(headers).send(body)，把 HttpError 翻译成 res.status().json()。
  router.post("/v1/audio/speech", requireApiKey, asyncHandler(
    async (req, res) => { const done = registerInflight(req, res); try { return await speechService(req, res); } finally { done(); } },
    (err) => { console.error("[ERROR] /v1/audio/speech failed:", err.message); return clientError(err); },
  ));

  // OpenAI 兼容的模型列表。GET /v1/models 与 /v1/models/:model 把可调用的 TTS「模型」报出来，
  // 免得标准 OpenAI 客户端（连上时会探 /v1/models）把 broker 当成不可达。每一项都标成
  // TTS 模型（owned_by "aurivox-tts"，task "tts"），id 正是 /v1/audio/speech 接受的那种
  // `voice`：配方 id、裸音色名、内置底模。
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

  router.get("/v1/models/*", requireApiKey, asyncHandler(async (req) => {
    const id = req.params[0];
    const found = listTtsModels().find((m) => m.id === id);
    if (!found) throw new HttpError(404, { message: `Model '${id}' not found`,
      type: "invalid_request_error", code: "model_not_found", param: "model" });
    return found;
  }));

  return router;
};
