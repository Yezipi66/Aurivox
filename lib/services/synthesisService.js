// 纯服务层：接收带 body 的请求对象，返回可 JSON 序列化的结果。不碰 Express 的 req/res，
// HTTP 适配在 lib/routes/synthesis.js 那一层。引擎由请求点名（engine_id），平台不代为选择。

const { HttpError } = require("../http/http");
const { remapOverridesForSegment } = require("../util/positionOverrides");
const { synthesisFailureDetail } = require("./failureDetail");
const { resolveEngineProfile: _resolveEngineProfile } = require("../engines/profile");
const { callSlots, launchSlots } = require("../engines/residency");
const { weightSummary } = require("../engines/weightSummary");

module.exports = function createSynthesisService(ctx) {
 const { baseVoiceReg, buildTtsPayload, resolveReference, clientError, computeSegmentBounds, concatWavFiles, fs, genAssetDir, genBaseName, generateOneSegment, isBaseVoice, loadVoices, newGenId, normSource, path, resolveSeed, splitJapaneseText, switchModels, toPcm16Wav, wavDurationSec, withGenerationLock, writeGenMeta } = ctx;

 // 名片解析可以从 ctx 注入（测试用），默认走真注册表。进程看管人（按需启动、空闲释放）可以没有，没有的时候平台不起停任何东西。
 const engineSupervisor = ctx.engineSupervisor || null;

 const resolveEngineProfile = ctx.resolveEngineProfile || _resolveEngineProfile;

 // 失败文案由 lib/services/failureDetail.js 出：它是纯函数，不碰 ctx。

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
 // 这一次合成用哪台引擎。不传就当场拒收。
 engine_id,
 // 开进程那一刻才吃得进去的那些模型，这一次选了哪几份。键是位名（平台自己的词），不是引擎参数名：
 // 收件人是平台，不是引擎。它永远不会进 payload：进了就是给引擎发一个它不读的键。
 launch_weights,
} = req.body || {};
if (!voice) throw new HttpError(400, "Missing 'voice' field");
if (typeof text !== "string" || text === "") {
 throw new HttpError(400, "Missing 'text' field", { code: "TEXT_REQUIRED" });
}
if (text.length > 5000) throw new HttpError(400, "Text too long (max 5000 chars)");

// 只查这个音色登记过没有。
let voices;
try { voices = loadVoices(); } catch (err) { throw new HttpError(500, clientError(err, "voices.json error")); }
// 内置底模音色不在 voices.json 里，在内存里解析出来，这样不微调也能直接用预训练权重做零样本推理。
const voiceReg = voices[voice] || (isBaseVoice(voice) ? baseVoiceReg() : null);
if (!voiceReg) throw new HttpError(404, `Unknown voice: ${voice}`);

// 配置由前端传的值拼成（不从 voices.json 取）。
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
 // 读音校对：本次合成的词粒度读音覆盖，仅在非空对象时透传给引擎。
 pron_overrides: (pron_overrides && typeof pron_overrides === "object" && !Array.isArray(pron_overrides) && Object.keys(pron_overrides).length) ? pron_overrides : undefined,
 // 逐字语言覆盖，用于共用汉字（{substring -> lang}）。
 lang_overrides: (lang_overrides && typeof lang_overrides === "object" && !Array.isArray(lang_overrides) && Object.keys(lang_overrides).length) ? lang_overrides : undefined,
 // 强制重新推理：跳过复用缓存的读（写照旧）。它是平台自己的词，不是任何一台引擎的参数，所以永远不会进 payload，
 // 否则它会进指纹，勾一次就把整张缓存表作废。
 force_resynth: !!(req.body && req.body.force_resynth),
 // 与 force_resynth 同理是平台自己的词，跟随 cfg 只是为了让下面能拿到。
 launch_weights: (launch_weights && typeof launch_weights === "object" && !Array.isArray(launch_weights) && Object.keys(launch_weights).length) ? launch_weights : undefined,
};
// auto（多语种）：无假名的 CJK 回落。归一到与 speechService 同一个具体集合闸门，auto 或空总是解析成一个合法的基底语言成员（默认 zh），与引擎的 _norm_base_lang 一致。
if (cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja") {
 const _albRaw = String(auto_base_lang || voiceReg.language || voiceReg.text_lang || "zh").toLowerCase();
 cfg.auto_base_lang = ["zh", "ja", "yue", "ko", "en"].includes(_albRaw) ? _albRaw : "zh";
}

// 引擎跟随请求走：请求点名哪台引擎，就用哪台。不点名就当场拒收：平台没有「默认引擎」，
// 有默认引擎的话第 N+1 台就得回答「我算不算默认」，而这个问题每台答案都不同。选错引擎的症状是「参数都对、声音不对」，几乎查不出来。
if (!engine_id) {
 throw new HttpError(400,
 '这次合成没说要用哪台引擎（请求里缺 engine_id）。' +
 '平台不代为选择：选错的症状是「参数都对、声音不对」或者引擎原话报错，' +
 '几乎查不出来。请在请求里带上 engine_id。');
}
let engine;
try {
 engine = resolveEngineProfile(engine_id);
} catch (err) {
 throw new HttpError(400, `Engine unavailable: ${(err && err.message) || err}`);
}

// 在切换权重之前先解析参考：引擎要求参考片段落在它自己声明的时长窗口里，越界的片段送到 /tts 会被界面收成一句含糊的「Segment 0 failed」。
// 解析器出的是平台自己的词（reference_audio / reference_text），与任何引擎无关；读引擎自己的键名会取到 undefined，于是下面那道「参考音频在不在」的检查会静默失效。
const resolvedReference = resolveReference(cfg);
cfg.reference_audio = resolvedReference.reference_audio;
cfg.reference_text = resolvedReference.reference_text;

// 启动前检查。只点两样，都只点「在不在」，绝不点「对不对」：参考音频（名片说要的话）与这台引擎的参数格子非空（名片说要的话）。
// 格子里有几个键、叫什么、值合不合法，一个都不看：写错了引擎自己会报错，那个报错比平台瞎猜的准。平台是搬运工。
// reference_clip_seconds 是对象 { min, max }，不是数组：写成 clip[0]/clip[1] 会拿到 undefined，于是 seconds < undefined 恒为 false，整个时长检查会静默失效。
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
 // 引擎名来自名片（engine.label）。
 throw new HttpError(400, `Reference audio is ${seconds.toFixed(1)}s; ${engine.label} requires a ${clip.min}–${clip.max}s reference clip. Choose another slice before generating.`);
 }
}
// 硬校验之二：参数格子非空。规则只认「点名的引擎」与「带的那袋参数」是不是同一台。
// 不认名片声明的 requires_engine_params 那种键：profile.js 从来没生产过它，恒为 undefined，整条检查一次都没跑过。
// 为什么不做无条件校验：webui 那条老路径不发 engine_id 也不发 engine_params，无条件校验会让每一次 webui 合成都变成 400；凡是新形状的调用（flow 画布、broker 走配方、下游作者接的引擎）都带 engine_id，所以这条规则对它们一定生效。带了别人的格子等于界面按 A 画、请求点名 B，这种错配照样 400，而且直接说出那组参数是谁的。
{
 const boxes = (req.body && req.body.engine_params) || null;
 const names = boxes && typeof boxes === "object" && !Array.isArray(boxes) ? Object.keys(boxes) : [];
 const filled = names.filter((n) => {
 const b = boxes[n];
 return b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0;
 });
  // 一格都没装则放行（这台引擎可能就是没有参数）。装了，但没有一格是这台引擎的则拒收，并点名那袋参数属于谁。
 if (filled.length && !filled.includes(engine.id)) {
 throw new HttpError(400,
 `这次点名要用的是引擎 '${engine.id}'，但请求里带的参数格子是 ${filled.map((n) => `'${n}'`).join('、')} 的。` +
 `参数和引擎不匹配：界面按一台引擎画格子、请求却发给另一台，症状是「参数都调了却没效果」或者引擎报一句看不懂的错。` +
 `请把参数放进 engine_params.${engine.id}。`);
 }
}

// 启动参数也按引擎分格，与调用参数同一套规则：格子必须是这台引擎的。
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
 throw new HttpError(400, `启动参数和引擎不匹配：当前是 '${engine.id}'，收到的是 ${filledLoad.join('、')}。`);
 }
 const box = loadBoxes[engine.id];
 if (box !== undefined && (!box || typeof box !== 'object' || Array.isArray(box))) {
 throw new HttpError(400, `engine_load_params.${engine.id} 必须是对象。`);
 }
 engineLoadParams = box || {};
}
// 名片把每个参数标了 phase：load 的只在开进程那一步吃进去，其余是调用参数。
// 调用参数与启动参数分开归位：同一个键不能既当启动参数发一次又当调用参数发一次。
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
// 「引擎整批」模式：不是平台把文本切开逐段顺序合成（每段一次 /tts），而是把整段文本一次交给引擎，
// 由引擎自己按 text_split_method 切块，并用 batch_size 与 parallel_infer 并行跑这些块（OpenAI 的 /v1/audio/speech 端点用的就是这套）。
// 取舍：引擎内部自己拼接，所以没有逐段文件（只有一个 audio.wav），Node 侧的拼接与 silence_ms 都不再适用，段间空隙由引擎的 fragment_interval 决定。
const engineBatch = engine_batch === true || engine_batch === "true";
// 默认分段长度由名片给，不是 30：splitJapaneseText 自己的默认参数虽然是 30，但这条路径永远显式传 softLimit，那个 30 从来轮不到。
const softLimit = Math.max(10, parseInt(max_chars, 10) || engine.max_chars);
const silenceMs = Math.min(2000, Math.max(0, parseInt(silence_ms, 10) || 300));
// 引擎只回 WAV；format 参数为了 API 兼容收下，但产物永远是 wav。
const mediaType = "wav";
const genId = newGenId();
const genSource = normSource(source);
const genDir = genAssetDir(genId, genSource);
fs.mkdirSync(genDir, { recursive: true });
const genUrlBase = `/outputs/${genSource}/${genId}`;
// 可选地关联回一份已存的配方：OpenAI 端点和任何走配方的生成都带上 recipe_id，这样 Broker 页面与历史记录能把产物和产出它的配方连起来。
const genRecipeId = (req.body && typeof req.body.recipe_id === "string") ? req.body.recipe_id : null;
// 批次分组：对比参考音频（以及将来任何多产物的一次运行）给每次生成打上同一个批次 id，这样「全部生成」被记成一次对比批次，而不是一堆分不清彼此的独立推理。
// 批次靠成员 meta.json 分组重建，不另存清单文件，避免与实际结果走偏。
const genBatch = (() => {
 const b = req.body || {};
 const id = (typeof b.batch_id === "string" && b.batch_id.trim()) ? b.batch_id.trim().slice(0, 80) : null;
 if (!id) return null;
 const toInt = (v) => (Number.isInteger(v) ? v : (parseInt(v, 10) || 0));
 return { id, seq: toInt(b.batch_seq), total: toInt(b.batch_total),
 label: (typeof b.batch_label === "string") ? b.batch_label.slice(0, 200) : "" };
})();
  // 存下来供重跑用的配方不能带批次字段：带上的话重跑会悄悄并回一个陈旧的批次。剥掉；批次只住在 meta.batch 里。
  // force_resynth 同理，而且理由更硬：它是一次性动作（「这一次别复用」），不是配方的属性。存进配方的话，重跑会永远强制重推，
  // 而重跑恰恰是最该命中缓存的那个按钮。它的当次取值照旧记在 meta.reuse.forced 上，查得到，只是不跟着配方走。
const { batch_id: _bid, batch_seq: _bseq, batch_total: _btot, batch_label: _blbl,
 force_resynth: _fr,
 ...recipeBody } = (req.body || {});
// 存的是解析后的（面向引擎的）auto 回落值，不是界面上的原值：存原值会让元数据看起来像是引擎收到一个没解析的语言。
const capturedRecipe = { ...recipeBody, seed: cfg.seed };
if (cfg.auto_base_lang) capturedRecipe.auto_base_lang = cfg.auto_base_lang;
// 各分支共用的审计字段；每个分支自己加 split/concat/segments/audio_url/files。
const metaBase = {
 id: genId, source: genSource, createdAt: Date.now(),
 voice, voiceLabel: voice_label || voice, text, lang: cfg.text_lang,
 auto_base_lang: cfg.auto_base_lang || undefined,
  // 这一次用了哪台引擎、哪几个位、每个位落的是哪一份，全部按名片记。
  // 不再有 gpt / sovits / gpt_model / sovits_model 这四个键：它们是第一台引擎的私有词汇，留着就一定会被下一处显示代码当成「平台的字段」再抄一遍。
  // 要看完整参数去 meta.recipe，那里存的是原样的请求体，重跑就是拿它重放的。
 engine_id: engine.id,
  // 引擎的显示名同样是名片说的（engine.label）。平台不给引擎起名字。
 engine_label: engine.label || engine.id,
 weights: weightSummary(engine.weight_slots, cfg),
 ref_audio: cfg.reference_audio, ref_text: cfg.reference_text,
 recipe_id: genRecipeId,
  // 批次归属（普通的一次性生成为 null）。
 batch: genBatch,
  // 记的是解析后的种子（绝不会是 -1），同时进顶层审计字段和存下来的配方，这样重跑（重放 meta.recipe）会用同一个种子重新合成，而不是重新随机。
  // 这不是逐字节可复现的：同样的种子会给出听感相同的一次演绎，但不会给出同一个文件。
  // GPU 上的浮点运算本身不保证逐位一致，所以任何建立在字节相等上的东西（按输入做键的结果缓存、「变了没有」的 diff）都必须把这个差距当成一件有意的事。
 seed: cfg.seed,
 recipe: capturedRecipe, status: "ok",
};

  // 整个持锁期间，这台引擎要被标成「正在忙」。少了这一句会有一个只在出现的 bug：定时清扫是不持锁的，
  // 它会把一台正在合成、只是这一段算得久的引擎当成「空闲」放掉：进程没了，这一次合成失败，而且看不出原因。
  // 收尾放在锁外面的 finally：不管这一次是成功、报错还是被挤掉，标记都必须清掉，清不掉的话这台引擎从此永不释放。
try {
return await withGenerationLock(async () => {
  // 换模型：两步，各管各的一半。「这一份选择送到哪一步」写在模型位上，只有两种，而且穷尽：
  // 开进程那一步吃进去的，换它就是带着新的重开一次进程（第 1 步）；进程活着时一次调用能换的，换它就是发一次请求（第 2 步）。
  // 判据是「这台引擎有没有这种位」，不是引擎级的一个是非题：一台引擎完全可以两种位都有。
  // 两步都在这把合成锁里面：同一时刻只能有一个请求在决定要不要重开进程。在锁外面做的话，两个请求会同时给同一台引擎装两份不同的模型。

  // 第 1 步：保证这台引擎正在运行，而且装的就是这一次要的那一份。
  // 没装看管人（老部署、测试夹具）则跳过。不抛：那会让一个纯粹的接线缺失表现成「合成失败」。
 if (engineSupervisor && (launchSlots(engine).length > 0 || Object.keys(engineLoadParams).length > 0)) {
 try {
 await engineSupervisor.ensure(engine, cfg.launch_weights || {}, {
 loadParams: engineLoadParams,
 confirmed: req.body && req.body.memory_risk_confirmed === true,
 });
 } catch (err) {
 const safeSupervisorCodes = new Set([
 'ENGINE_MEMORY_CONFIRM_REQUIRED',
 'ENGINE_BUSY_OTHER_WEIGHT',
 'ENGINE_TOO_MANY_LAUNCH_SLOTS',
 'ENGINE_SPAWN_FAILED',
 'ENGINE_EXITED_EARLY',
 'ENGINE_READY_TIMEOUT',
 ]);
 if (err && safeSupervisorCodes.has(err.code)) {
 const status = err.code === 'ENGINE_MEMORY_CONFIRM_REQUIRED' ? 409 : 500;
 const details = err.mem ? {
 engine_id: err.id || engine.id,
 historical_peak_mb: Number.isFinite(err.mem.needMb) ? err.mem.needMb : null,
 required_mb: Number.isFinite(err.mem.wantMb) ? err.mem.wantMb : null,
 free_mb: Number.isFinite(err.mem.freeMb) ? err.mem.freeMb : null,
 can_continue: err.can_continue === true,
 confirmation_scope: err.confirmation_scope || null,
 } : undefined;
 throw new HttpError(status, err.message, { code: err.code, details });
 }
 throw err;
 }
 }

  // 第 2 步：进程活着时一次调用就能换的那些位。没有这种位就别去敲那个接口：敲了会报错，而那个错长得像「合成失败」。
  // 第二个参数是「换给哪一台」，少了它这一句必抛（客户端不替调用方挑引擎）。
 if (callSlots(engine).length > 0) await switchModels(cfg, engine);

 // 从这里开始它真的在开始执行了。必须在 ensure 之后：那台进程可能还不存在，标了也没人认。
 if (engineSupervisor) engineSupervisor.markBusy(engine.id, true);

// 整段文本一次生成。走这一支的情形：不分段、文本短于 softLimit，或者开了引擎整批模式（引擎自己切块并对整段文本并行批处理）。
 if (!shouldSplit || engineBatch || text.length <= softLimit) {
 if (engineBatch) console.log(`[ENGINE-BATCH] whole text (${text.length} chars) -> single /tts call, engine splits+batches (batch_size=${cfg.batch_size ?? "default"})`);
// 这一支也要剥壳：不剥的话抛出去的原始错误会落到通用兜底，webui 上短句失败只显示 "Internal server error"。短句是最常见的试用场景，所以这个洞的暴露面比分段那支还大。
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

 // 分段生成。
 const segments = splitJapaneseText(text, { softLimit, hardLimit: softLimit * 2 });
 console.log(`[SPLIT] ${text.length} chars -> ${segments.length} segments`);

 const segFiles = [];
 const segResults = [];
 let segmentSearchFrom = 0;

 for (let i = 0; i < segments.length; i++) {
 const segText = segments[i];
    // 界面里的 @N 位置是按整段输入文本记的。broker 的每一段是一次独立的 /tts 请求，所以只把属于这一段的位置换算成段内 @0 起的坐标。
    // 不换算的话，@0/@1（例如「你好」上的粤语覆盖）会被重新套到后面每一段的开头。
 const remapped = remapOverridesForSegment(cfg, text, segText, segmentSearchFrom);
 segmentSearchFrom = remapped.nextCodeUnit;
 const segmentCfg = remapped.cfg;
 console.log(`[SEG ${i}/${segments.length - 1}] "${segText.slice(0, 30)}..." (${segText.length} chars, source_offset=${remapped.segmentStart ?? 0})`);
 try {
    // 出参：这一段是复用的还是真推的。用出参而不是改返回值，是因为盘上有多份假 generateOneSegment
    //（各测试的 harness），改返回值形状会把它们全部拖下水；出参对它们完全透明（不写 out 就读到 undefined）。
 const segCache = {};
 const audioBytes = toPcm16Wav(await generateOneSegment(segText, segmentCfg, engine, segCache));
 const segName = `seg${String(i).padStart(3, "0")}.${mediaType}`;
 const segPath = path.join(genDir, segName);
 fs.writeFileSync(segPath, audioBytes);
 segFiles.push(segPath);
 segResults.push({ index: i, text: segText, source_start: remapped.segmentStart ?? 0, audio_url: `${genUrlBase}/${segName}`,
 // 留痕：这一段是不是复用的。meta.json 里能看出来，否则「怎么这次只用了 4 秒」将来没人查得清。
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

 // 复用留痕（meta.json 里能看出来这次省了多少）。记的是段数不是秒数：秒数得计时，而段数就在手上。
 const reuseSummary = {
 reused_segments: segResults.filter(s => s.reused).length,
 total_segments: segResults.length,
 forced: !!cfg.force_resynth,
 };

 if (!shouldConcat || segFiles.length === 1) {
 // 没要求拼接，或者只有一段。
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

 // 拼接。
 const combinedName = `combined.${mediaType}`;
 const combinedPath = path.join(genDir, combinedName);

 try {
 const concatResult = await concatWavFiles(segFiles, combinedPath, silenceMs);
 const combinedSize = fs.statSync(combinedPath).size;
 console.log(`[OK] Combined: ${genId}/${combinedName} (${combinedSize} bytes, method: ${concatResult.method})`);

 const combinedUrl = `${genUrlBase}/${combinedName}`;
 // 段边界偏移，给波形预览的分隔线用。
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
