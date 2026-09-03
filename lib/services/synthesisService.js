// ===========================
//  SERVICE: Legacy synthesis (FLOW-CORE-003B)
// ===========================
// Pure service extraction from routes/synthesis.js. It receives a request-like
// object with `body` and returns a JSON-serialisable result. It never touches
// Express req/res; the route remains the HTTP adapter.

const { HttpError } = require("../http/http");
const { remapOverridesForSegment } = require("../util/positionOverrides");
const { synthesisFailureDetail } = require("./failureDetail");
const { resolveEngineProfile: _resolveEngineProfile } = require("../engines/profile");
const { callSlots, launchSlots } = require("../engines/residency");
const { weightSummary } = require("../engines/weightSummary");

module.exports = function createSynthesisService(ctx) {
  const { baseVoiceReg, buildTtsPayload, resolveReference, clientError, computeSegmentBounds, concatWavFiles, fs, genAssetDir, genBaseName, generateOneSegment, isBaseVoice, loadVoices, newGenId, normSource, path, resolveSeed, splitJapaneseText, switchModels, toPcm16Wav, wavDurationSec, withGenerationLock, writeGenMeta } = ctx;

  // 名片解析可以从 ctx 注入（测试用），默认走真注册表。
  // 进程看管人（用到才起、空闲就放）。⚠ 可以没有 —— 没有的时候平台不起停
  //   任何东西，行为回到"引擎全靠启动脚本点着"，那是这一刀之前的样子。
  const engineSupervisor = ctx.engineSupervisor || null;

  const resolveEngineProfile = ctx.resolveEngineProfile || _resolveEngineProfile;

// synthesisFailureDetail 已提到 lib/services/failureDetail.js —— 它是纯函数、
// 不碰 ctx，而且现在是两个调用方（分段支 + 单段支）共同的承重，
// 埋在工厂闭包里就没法给它单独立守卫。

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
  // 契约 v2 第 1b 步：这一次合成用哪台引擎。
  // 不传 = 老路径引擎（名片上写 legacy_default:true 的那台）—— webui 今天
  // 就是不传的，所以它的行为一个字没变。
  engine_id,
  // ⭐⭐⭐ 开进程那一刻才吃得进去的那些模型，这一次选了哪几份。
  //   键是**位名**（平台自己的词），不是引擎参数名 —— 收件人是平台不是引擎。
  //   ⛔ 它永远不会进 payload：进了就是给引擎发一个它不读的键。
  launch_weights,
} = req.body || {};
if (!voice) throw new HttpError(400, "Missing 'voice' field");
if (typeof text !== "string" || text === "") {
  throw new HttpError(400, "Missing 'text' field", { code: "TEXT_REQUIRED" });
}
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
  // ⭐ 强制重新推理：跳过复用缓存的**读**（写照旧，见 server.js 里的说明）。
  //   它是平台自己的词，不是任何一台引擎的参数 —— 所以它在
  //   PLATFORM_REQUEST_KEYS 上，而且**永远不会进 payload**，
  //   否则它会进指纹，勾一次就把整张缓存表作废。
  force_resynth: !!(req.body && req.body.force_resynth),
  // 和 force_resynth 一样是平台自己的词，跟着 cfg 走只是为了让下面拿得到。
  launch_weights: (launch_weights && typeof launch_weights === "object" && !Array.isArray(launch_weights) && Object.keys(launch_weights).length) ? launch_weights : undefined,
};
// Auto (Multilingual): kana-free CJK fallback — normalise through the same
// concrete-set gate as speechService so `auto` / blank always resolves to a
// valid _ML_BASE_LANGS member (default "zh"), matching the engine's _norm_base_lang.
if (cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja") {
    const _albRaw = String(auto_base_lang || voiceReg.language || voiceReg.text_lang || "zh").toLowerCase();
    cfg.auto_base_lang = ["zh", "ja", "yue", "ko", "en"].includes(_albRaw) ? _albRaw : "zh";
}

// ---- 引擎跟着请求走 --------------------------------------------------------
// ⭐⭐⭐ 这里过去写的是：
//       engine = engine_id ? resolve(engine_id) : resolve(findLegacyDefaultId())
//     —— 请求不点名，就去名片里找 legacy_default 那台顶上。
//
//   那一句是 `tts failed` 的病根本身，不是它的邻居：web 前端从来不发
//   engine_id（它只把 engine_id 存进 recipe），所以**界面上无论选哪台
//   引擎，这条路永远解析成 legacy_default 那一台**。格子按 A 画、参数按
//   A 发、权重按 A 选，请求打到 B 身上，用户看到的是 B 的原话。
//
//   现在前端点名了（GenerateTab / ReferenceCompareTab 都发 engine_id），
//   所以这里的认领人一并拿掉：**没人说连哪台，就说"你没说"，不猜。**
//   ⛔ 平台没有"默认引擎"这个概念 —— 一有默认引擎，第 N+1 台就永远要
//     回答"我算不算默认"，而这个问题对每台引擎的答案都不一样。
if (!engine_id) {
  throw new HttpError(400,
    '这次合成没说要用哪台引擎（请求里缺 engine_id）。' +
    '平台不替你挑一台 —— 挑错的症状是「参数都对、声音不对」或者引擎原话报错，' +
    '几乎查不出来。请在请求里带上 engine_id。');
}
let engine;
try {
  engine = resolveEngineProfile(engine_id);
} catch (err) {
  throw new HttpError(400, `Engine unavailable: ${(err && err.message) || err}`);
}

// Resolve the reference once before model switching. The engine strictly needs
// a clip inside its own declared window; previously an invalid slice reached
// /tts and was collapsed by the UI into the misleading generic
// "Segment 0 failed" message.
// ⭐ 第 1c 步：这里过去写的是 `buildTtsPayload("", cfg)` 然后读
//    `.ref_audio_path` / `.prompt_text` —— 那是**GPT-SoVITS 的键名**。
//    在一台把参考音频叫别的名字的引擎上，这两句会取到 undefined，于是
//    下面那道"参考音频在不在"的检查静默失效，一声不吭。
//    改成问平台自己的解析器要平台自己的词，与任何引擎无关。
const resolvedReference = resolveReference(cfg);
cfg.reference_audio = resolvedReference.reference_audio;
cfg.reference_text = resolvedReference.reference_text;

// ---- 开跑前点料 -----------------------------------------------------------
// 只点两样，都只点「在不在」，绝不点「对不对」：
//   1. 参考音频（名片说要的话）
//   2. 这台引擎的参数格子非空（名片说要的话）
// 格子里有几个键、叫什么、值合不合法 —— 一个都不看。写错了引擎自己会报错，
// 那个报错比我们瞎猜的准。平台是搬运工，不是翻译。
// ⚠ reference_clip_seconds 是**对象** { min, max }，不是数组。
//   我第一版写成 clip[0]/clip[1]，拿到 undefined，于是 `seconds < undefined`
//   恒为 false —— 整个时长检查静默失效，一声不吭。被钉子当场抓住。
const clip = engine.reference_clip_seconds;
if (engine.requires_reference_audio) {
  if (!cfg.reference_audio || !fs.existsSync(cfg.reference_audio)) {
    const window = clip ? `${clip.min}–${clip.max} second` : "";
    throw new HttpError(400, `Reference audio is missing. Select an existing ${window} reference clip before generating.`.replace(/\s{2,}/g, " "));
  }
}
if (clip && cfg.reference_audio && /\.wav$/i.test(cfg.reference_audio) && typeof wavDurationSec === "function") {
  const seconds = wavDurationSec(cfg.reference_audio);
  if (seconds > 0 && (seconds < clip.min || seconds > clip.max)) {
    // 名字来自名片（engine.label）。老路径引擎的 label 就是 "GPT-SoVITS"，
    // 所以钉子测试匹配到的那句话是**数据驱动出来的**，不是硬编码。
    throw new HttpError(400, `Reference audio is ${seconds.toFixed(1)}s; ${engine.label} requires a ${clip.min}–${clip.max}s reference clip. Choose another slice before generating.`);
  }
}
// ---- 硬校验之二：参数格子非空 ---------------------------------------------
// ⛔ 这里曾经写的是 `if (engine.requires_engine_params)` —— 而 profile.js
//    **从来没有生产过这个键**，真机上恒为 undefined，所以整条检查一次都没跑过。
//    5 个测试之所以全绿，是因为它们直接塞了一个假名片对象进来，绕过了
//    profile.js；连突变验证都被同一层假名片骗过去了。这是同一类错误的第三次
//    （前两次：clip[0] 拿到 undefined、max_chars 抄了死路径的 30）。
//    教训写在这里：**「名片里先声明、以后再接线」等于制造死代码**。
//
// 换成不依赖任何名片声明的规则（Owner 2026-08-23 定：只校验两样）：
//
//     凡是明确说了「我要用哪台引擎」的调用，必须同时带上那台引擎的参数格子。
//
// 为什么不是无条件校验：webui 那条老路径根本不发 engine_id，也不发
// engine_params —— 无条件校验会让每一次 webui 合成都变成 400。而凡是新形状的
// 调用（flow 画布、broker 走配方、下游作者接的引擎）都一定带 engine_id，
// 所以这条规则对它们 100% 生效。
//
// ⭐ 2026-08-28 订正：「凡是新形状的调用都一定带 engine_id」这句话，写下时是
//   *期望*，现在是*被强制的事实* —— 契约 §12 第 2 步已经让那两条路在入口处
//   就拒收缺失的 engine_id：
//       broker  routes/synthesis.js            缺 ⇒ 400
//       flow    flowgraph/adapter.js           缺 ⇒ FG_ENGINE_ID_MISSING
//   ⇒ 走到这一行还没有 engine_id 的，**只可能是 webui**。
//
// ⛔ 但这不等于可以把上面那个 `if (engine_id)` 改成无条件 —— 恰恰相反，正因为
//   剩下的全是 webui，去掉这个条件就等于点名把 webui 打成 400。这个条件
//   （连同那条 findLegacyDefaultId 回落）消失的时刻，是 **web 前端开始
//   发 engine_id 的那一刻**，不是「调用点数到零」的那一刻。
//
// ⭐⭐⭐ 2026-08-31（刀 A1）：**那一刻已经到了。**
//   `web/src/components/generate/GenerateTab.jsx:553` 的 /api/generate 请求体
//   里有 `engine_id: engine?.id`（旁边注释还写着「⛔ 也不许写成
//   `engine?.id || '某个默认值'`」）⇒ `legacyDefault.js` 连同名片上的
//   `legacy_default` 已于本刀整份删除。
//   ⚠ 下面这个 `if (!engine_id)` 的分支**保留**：它现在的作用是把
//     「一个没点名的调用」当场说出来，⛔ 不是替它挑一台。
//
// ⚠ 只点「在不在」，绝不点「对不对」：格子里有几个键、叫什么、值合不合法，
//   一个都不看。写错了引擎自己会报错，那个报错比我们瞎猜的准。
// ⭐⭐ 2026-08-30 订正（刀 2）：上面那句「凡是新形状的调用都一定带 engine_id，
//   所以格子必须非空」里藏着一条**只对某几台引擎为真**的知识 ——
//   「一台引擎一定有参数可调」。IndexTTS2 有 12 个、GSV 有 34 个，于是这条
//   看起来永真；可「参数一个都没有」是一台完全合法的引擎（名片 params.schema
//   为空），它会被这一行打成 400，而它什么也没做错。
//   ⇒ 平台不许替引擎规定「你得有参数」。
//
//   真正该守的那件事一个字没丢，而且更准：**发来的参数格子必须是这台引擎的**。
//   带了别人的格子 = 界面按 A 画、请求点名 B，就是这一刀要根除的那种错配 ——
//   照样 400，而且直接说出那袋参数其实是谁的。
{
  const boxes = (req.body && req.body.engine_params) || null;
  const names = boxes && typeof boxes === "object" && !Array.isArray(boxes) ? Object.keys(boxes) : [];
  const filled = names.filter((n) => {
    const b = boxes[n];
    return b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0;
  });
  // 一格都没装 ⇒ 放行（这台引擎可能就是没有参数）。
  // 装了，但没有一格是这台引擎的 ⇒ 拒收，并点名那袋参数属于谁。
  if (filled.length && !filled.includes(engine.id)) {
    throw new HttpError(400,
      `这次点名要用的是引擎 '${engine.id}'，但请求里带的参数格子是 ${filled.map((n) => `'${n}'`).join('、')} 的。` +
      `参数和引擎对不上 —— 界面按一台引擎画格子、请求却发给另一台，症状是「参数都调了却没效果」或者引擎报一句看不懂的错。` +
      `请把参数放进 engine_params.${engine.id}。`);
  }
}

const loadBoxes = (req.body && req.body.engine_load_params) || null;
let engineLoadParams = {};
if (loadBoxes !== null && (typeof loadBoxes !== 'object' || Array.isArray(loadBoxes))) {
  throw new HttpError(400, 'engine_load_params 必须是按 engine_id 分格的对象。');
}
if (loadBoxes) {
  const filledLoad = Object.keys(loadBoxes).filter((name) => {
    const box = loadBoxes[name];
    return box && typeof box === 'object' && !Array.isArray(box) && Object.keys(box).length > 0;
  });
  if (filledLoad.length && !filledLoad.includes(engine.id)) {
    throw new HttpError(400, `启动参数和引擎对不上：当前是 '${engine.id}'，收到的是 ${filledLoad.join('、')}。`);
  }
  const box = loadBoxes[engine.id];
  if (box !== undefined && (!box || typeof box !== 'object' || Array.isArray(box))) {
    throw new HttpError(400, `engine_load_params.${engine.id} 必须是对象。`);
  }
  engineLoadParams = box || {};
}
const allowedLoad = new Set((engine.param_schema || []).filter((f) => f.phase === 'load').map((f) => f.name));
const requestBoxes = req.body && req.body.engine_params;
const requestBox = requestBoxes && typeof requestBoxes === 'object' && !Array.isArray(requestBoxes)
  ? requestBoxes[engine.id] : null;
if (requestBox && typeof requestBox === 'object' && !Array.isArray(requestBox)) {
  const callOnly = {};
  for (const [name, value] of Object.entries(requestBox)) {
    if (allowedLoad.has(name)) {
      if (!Object.prototype.hasOwnProperty.call(engineLoadParams, name)) engineLoadParams[name] = value;
    } else {
      callOnly[name] = value;
    }
  }
  req.body.engine_params = Object.assign({}, requestBoxes, { [engine.id]: callOnly });
}
const unknownLoad = Object.keys(engineLoadParams).filter((name) => !allowedLoad.has(name));
if (unknownLoad.length) {
  throw new HttpError(400, `这些参数没有声明为 load：${unknownLoad.join('、')}。`);
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
// 默认分段长度改由名片给（gpt-sovits 名片写的就是 45，与搬家前一字不差）。
// ⚠ 不是 30：splitJapaneseText 自己的默认参数虽然是 30，但这条路径永远显式
//    传 softLimit，那个 30 从来轮不到。
const softLimit = Math.max(10, parseInt(max_chars, 10) || engine.max_chars);
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
//
// ⭐ force_resynth 同理，而且理由更硬：它是一次性**动作**（「这一次别复用」），
//   不是配方的属性。存进 recipe 的话，Rerun 会永远强制重推 —— 而 Rerun 恰恰
//   是最该命中缓存的那个按钮（同一份配方原样再跑一遍）。它的现场取值照旧记在
//   meta.reuse.forced 上，查得到，只是不跟着配方走。
const { batch_id: _bid, batch_seq: _bseq, batch_total: _btot, batch_label: _blbl,
  force_resynth: _fr,
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
  // ⭐⭐ 2026-08-31。这三行以前是：
  //        gpt:    genBaseName(cfg.gpt_model)    || "-",
  //        sovits: genBaseName(cfg.sovits_model) || "-",
  //        gpt_model: cfg.gpt_model, sovits_model: cfg.sovits_model,
  //   —— 位名写死、位的个数写死成 2。跑 IndexTTS2 的那一条留下的是
  //   「GPT - / SoVITS -」：两个它根本没有的位，各配一个横杠。
  //
  //   现在这一次用了哪台引擎、哪几个位、每个位落的是哪一份，全部按名片记。
  //   ⛔ 不再有 gpt / sovits / gpt_model / sovits_model 这四个键 —— 它们是
  //     第一台引擎的私有词汇，留着就一定会被下一处显示代码当成"平台的字段"
  //     再抄一遍（今天这一处就是这么来的）。要看完整参数去 meta.recipe，
  //     那里存的是**原样的请求体**，Rerun 就是拿它重放的。
  engine_id: engine.id,
  // 引擎的显示名同样是名片说的（engine.label）。平台不给引擎起名字。
  engine_label: engine.label || engine.id,
  weights: weightSummary(engine.weight_slots, cfg),
  ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
  recipe_id: genRecipeId,
  // Batch membership (null for ordinary one-off generations).
  batch: genBatch,
  // Reproducibility: stamp the RESOLVED seed (never -1) into both the top-level audit
  // field and the captured recipe, so Rerun (which replays meta.recipe) re-synthesises
  // with the SAME seed instead of re-randomising.
  //
  // ⚠ This is NOT bit-exact, and this comment used to claim it was. Measured on real
  // hardware 2026-08-23 (GPT-SoVITS / CUDA): two runs whose meta.recipe was identical
  // key-for-key (same seed, text, reference, weights, every knob) produced the same
  // segment count (3) and the same byte length (768938), but 53 of 384447 samples
  // differed — by exactly 1 LSB, i.e. ~-88 dB against a peak of 26230. Inaudible.
  //
  // That is ordinary GPU float non-determinism: PyTorch does not promise bit-identical
  // results unless deterministic algorithms are explicitly enabled, because cuDNN may
  // pick different reduction orders run to run. It is NOT a seed bug — if the seed were
  // being ignored the token sequences would diverge and the lengths could not match.
  //
  // So the honest statement is: Rerun reproduces the same PARAMETERS and a perceptually
  // identical take. It does not reproduce the same FILE. Anything built on byte equality
  // (a result cache keyed on inputs, a "did this change?" diff) must treat that gap as a
  // deliberate decision, not an assumption.
  seed: cfg.seed,
  recipe: capturedRecipe, status: "ok",
};

// ⭐⭐⭐ 整个持锁期间，这台引擎要被标成「正在忙」。
//   ⛔ 少了这一句会有一个只在真机上出现的 bug：定时清扫是**不持锁**的，
//     它会把一台正在合成、只是这一段算得久（有的引擎单段要三分多钟）的
//     引擎当成"空闲"放掉 —— 进程没了，这一次合成失败，而且看不出原因。
//   ⚠ 收尾放在锁**外面**的 finally：不管这一次是成功、报错还是被挤掉，
//     标记都必须清掉。清不掉的话这台引擎从此永不释放，B 就白做了。
try {
return await withGenerationLock(async () => {
    // ── 换模型：两步，各管各的一半 ────────────────────────────────────────
    //
    // ⭐⭐⭐ 「这一份选择送到哪一步」写在**模型位**上，只有两种，而且穷尽：
    //     开进程那一步吃进去的 ⇒ 换它 = 带着新的重开一次进程（下面第 1 步）
    //     进程活着时一次调用能换的 ⇒ 换它 = 发一次请求（下面第 2 步）
    //
    // ⛔ 这里过去问的是**引擎级**的那一个是非题（支持不支持热换），
    //   于是「开进程那一步吃进去」的那些位一整类都被跳过了 ——
    //   表现是下拉能选、后端连"你选过"都看不见、声音没变、而且不报错。
    //   一台引擎完全可以两种位都有，一个是非题答不了那种引擎。
    //
    // ⚠ 两步都在这把合成锁里面：同一时刻只能有一个请求在决定要不要重开进程。
    //   在锁外面做的话，两个请求会同时给同一台引擎装两份不同的模型。

    // 第 1 步：保证这台引擎正在跑，而且装的就是这一次要的那一份。
    // ⚠ 没装看管人（老部署、测试夹具）⇒ 跳过。⛔ 不抛：那会让一个纯粹的
    //   接线缺失表现成「合成失败」。
    if (engineSupervisor && (launchSlots(engine).length > 0 || Object.keys(engineLoadParams).length > 0)) {
      await engineSupervisor.ensure(engine, cfg.launch_weights || {}, { loadParams: engineLoadParams });
    }

    // 第 2 步：进程活着时一次调用就能换的那些位。
    // ⚠ 判据从「引擎说自己支持热换」改成「这台引擎有没有这种位」——
    //   同一件事的直接说法。没有这种位就别去敲那个接口：敲了会报错，
    //   而那个错长得像「合成失败」。
    // ⭐ 第二个参数是「换给哪一台」。少了它这一句必抛（客户端不替调用方挑
    //   引擎），症状是前端一按生成就 "Internal server error"。
    if (callSlots(engine).length > 0) await switchModels(cfg, engine);

    // 从这里开始它真的在干活了。⚠ 必须在 ensure **之后** —— 之前那台进程
    //   可能还不存在，标了也没人认。
    if (engineSupervisor) engineSupervisor.markBusy(engine.id, true);

    // Single whole-text generation. Taken when: split is disabled, the text is
    // short enough, OR engine-batch mode is on (the engine does its own split +
    // parallel batching over the whole text in one call).
    if (!shouldSplit || engineBatch || text.length <= softLimit) {
      if (engineBatch) console.log(`[ENGINE-BATCH] whole text (${text.length} chars) -> single /tts call, engine splits+batches (batch_size=${cfg.batch_size ?? "default"})`);
      // ⛔ 这一支过去**不剥壳**：分段那一支（下面 :3xx）用 try/catch 包了
      //   generateOneSegment 并走 synthesisFailureDetail，这一支没有 ⇒ 抛出去
      //   的原始错误落到通用兜底，webui 上短句失败只显示 "Internal server error"。
      //   （短句 = 最常见的试用场景，所以这个洞的暴露面比分段那支还大。）
      //   补上后两支的失败表述一致，引擎名/地址也才真的说得出来。
      let audioBytes;
      const wholeCache = {};
      try {
        audioBytes = toPcm16Wav(await generateOneSegment(text, cfg, engine, wholeCache));
      } catch (err) {
        throw new HttpError(502, synthesisFailureDetail(err), { ok: false, segments: [] });
      }
      fs.writeFileSync(path.join(genDir, "audio.wav"), audioBytes);
      const audioUrl = `${genUrlBase}/audio.wav`;
      writeGenMeta(genId, { ...metaBase, split: false, concat: false, segments: 1,
        engine_batch: engineBatch || undefined,
        // 不分段这一支也留痕，形状与分段支一致（1 段里复用了几段）
        reuse: { reused_segments: wholeCache.cached ? 1 : 0, total_segments: 1, forced: !!cfg.force_resynth },
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
        // ⭐ 出参：这一段是复用的还是真推的。用出参而不是改返回值，是因为盘上
        //   有 8 个假 generateOneSegment（各测试的 harness），改返回值形状会把
        //   它们全部拖下水；出参对它们完全透明（不写 out 就读到 undefined，
        //   语义正好是「不知道」）。
        const segCache = {};
        const audioBytes = toPcm16Wav(await generateOneSegment(segText, segmentCfg, engine, segCache));
        const segName = `seg${String(i).padStart(3, "0")}.${mediaType}`;
        const segPath = path.join(genDir, segName);
        fs.writeFileSync(segPath, audioBytes);
        segFiles.push(segPath);
        segResults.push({ index: i, text: segText, source_start: remapped.segmentStart ?? 0, audio_url: `${genUrlBase}/${segName}`,
          // 留痕：这一段是不是复用的。Owner 明确要求 meta.json 里能看出来
          // —— 否则「怎么这次只用了 4 秒」将来没人查得清。
          reused: segCache.cached === true });
        console.log(`[${segCache.cached ? "REUSE" : "OK"}] Segment ${i}: ${genId}/${segName} (${audioBytes.length} bytes)`);
      } catch (err) {
        console.error(`[FAIL] Segment ${i} failed: ${err.message}`);
        throw new HttpError(502, `Segment ${i} failed: ${synthesisFailureDetail(err)}`, {
          ok: false,
          segments: segResults,
        });
      }
    }

    // 复用留痕（Owner 要求 meta.json 里能看出来这次省了多少）。
    // 记的是**段数**不是秒数：秒数得计时，而段数就在手上，且实测耗时
    // ≈ 2.49 秒固定 + 1.44 秒 × 段数，段数够还原出省了多少。
    const reuseSummary = {
      reused_segments: segResults.filter(s => s.reused).length,
      total_segments: segResults.length,
      forced: !!cfg.force_resynth,
    };

    if (!shouldConcat || segFiles.length === 1) {
      // No concatenation requested or only one segment
      const first = segResults[0];
      writeGenMeta(genId, { ...metaBase, split: true, concat: false, segments: segResults.length,
        reuse: reuseSummary,
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
        reuse: reuseSummary,
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
} finally {
  if (engineSupervisor) engineSupervisor.markBusy(engine.id, false);
}
};

  return { generateService };
};
