// 纯服务层：接收带 body 的请求对象，返回可 JSON 序列化的结果。不碰 Express 的 req/res，
// HTTP 适配在 lib/routes/synthesis.js 那一层。引擎由请求点名（engine_id），平台不代为选择。

const { HttpError } = require("../http/http");
const { remapOverridesForSegment } = require("../util/positionOverrides");
const { synthesisFailureDetail } = require("./failureDetail");
const { resolveEngineProfile: _resolveEngineProfile, legacyLangToEngine } = require("../engines/profile");
const { callSlots, launchSlots } = require("../engines/residency");
const { weightSummary } = require("../engines/weightSummary");
const { usesStdio } = require("../engines/engineChannel");
const { coerceIncoming, isBlankValue, resolveIncomingKnobs, PLATFORM_REQUEST_KEYS } = require("../engines/paramTable");
const { resolveBaseLang } = require("../langCodes");
const { readLastSuccessRecipe: _readLastSuccessRecipe } = require("./lastSuccessRecipe");
const { OUTPUT_ROOTS } = require("../paths");

module.exports = function createSynthesisService(ctx) {
 const { baseVoiceReg, buildTtsPayload, resolveReference, clientError, computeSegmentBounds, concatWavFiles, fs, genAssetDir, genBaseName, generateOneSegment, isBaseVoice, loadVoices, newGenId, normSource, path, resolveSeed, splitJapaneseText, switchModels, toPcm16Wav, wavDurationSec, withGenerationLock, writeGenMeta } = ctx;

 // 名片解析可以从 ctx 注入（测试用），默认走真注册表。进程看管人（按需启动、空闲释放）可以没有，没有的时候平台不起停任何东西。
 const engineSupervisor = ctx.engineSupervisor || null;

 const resolveEngineProfile = ctx.resolveEngineProfile || _resolveEngineProfile;

 // 「上一次成功调用时填的值」的唯一产地是那次生成落盘的 meta.recipe；输出根目录与读法都可注入（测试用）。
 const readLastSuccessRecipe = ctx.readLastSuccessRecipe || _readLastSuccessRecipe;
 const outputRoots = ctx.outputRoots || OUTPUT_ROOTS;

 // 失败文案由 lib/services/failureDetail.js 出：它是纯函数，不碰 ctx。

const generateService = async (req) => {
const body = req.body || {};
const {
 voice, text, split, max_chars, concat, silence_ms,
 ref_audio, reference_text, aux_ref_audio_paths,
 speed_factor, seed, text_lang, prompt_lang, media_type,
 source, voice_label,
 pron_overrides, auto_base_lang, lang_overrides,
 engine_batch,
 // 这一次合成用哪台引擎。不传就当场拒收。
 engine_id,
 // 开进程那一刻才吃得进去的那些模型，这一次选了哪几份。键是位名（平台自己的词），不是引擎参数名：
 // 收件人是平台，不是引擎。它永远不会进 payload：进了就是给引擎发一个它不读的键。
 launch_weights,
} = body;
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

// cfg 四段拼装，顺序固定：knobs → slots → platform → engine_params。
// platform 覆盖 knobs；schema 键最终由 applyEngineKnobs 用归一后的平铺值再覆盖一次，
// 所以平铺值归一后有值时，格子里的同名键以平铺值为准；平铺值没出现、或归一成未填时，发出去的是格子里那份
// （格子进来的值也按名片声明归一，两个入口同一口径）。前面未出现的键留给名片 defaults：平台不写第二份默认值。
const cfg = { id: voice, voiceId: voice };

// 1) knobs：请求中出现且名片 schema 声明过的键，按声明类型归一；非法选项视为未填写。
// 留空（键出现了、值是空的）不再当成「没填」：那是用户明确清空了这一格。
// 有上一次成功调用 ⇒ 接过来它当时填的值，并把键名回给界面提醒；没有上一次 ⇒ 什么都不补，空值原样送出去，
// 由引擎自己说话（判据与后果见 issue #26 §14）。
const hasBlankKnob = (engine.param_schema || []).some((entry) =>
 Object.prototype.hasOwnProperty.call(body, entry.name) && isBlankValue(body[entry.name]));
const savedRecipe = hasBlankKnob
 ? readLastSuccessRecipe({ engineId: engine.id, outputRoots, fs, path })
 : null;
const knobs = resolveIncomingKnobs(engine, body, savedRecipe);
Object.assign(cfg, knobs.values);
const carriedOver = knobs.carriedOver;
// 只有真的替用户接过来值时才写这个键：没接过来的时候，响应与 meta 里不该多一个空键。
const carriedOverEntry = Object.keys(carriedOver).length ? { carried_over: carriedOver } : {};
// 2) slots：每个权重位选中的文件，按该位的 param 名写入 cfg。
for (const slot of (engine.weight_slots || [])) {
 if (!slot.param) continue;
 const v = body[slot.param];
 if (v === undefined || v === null) continue;
 cfg[slot.param] = v;
}

// 3) platform：平台语义（speed_factor / seed / 参考音频 / 语言），同名旋钮不得覆盖。
cfg.reference_audio = ref_audio || "";
cfg.reference_text = reference_text || "";
cfg.aux_ref_audio_paths = aux_ref_audio_paths || [];
// 语种的两个来源（调用方给的、音色登记的）过同一道换算：可识别的历史写法（all_zh 之类）换成该引擎的写法，其余按原值发出。
cfg.text_lang = legacyLangToEngine(engine.language_map,
 text_lang || voiceReg.text_lang || voiceReg.language || "auto");
cfg.prompt_lang = legacyLangToEngine(engine.language_map,
 prompt_lang || voiceReg.prompt_lang || voiceReg.language || "auto");
if (speed_factor !== undefined && speed_factor !== null && speed_factor !== "") {
 const n = parseFloat(speed_factor);
 if (Number.isFinite(n)) cfg.speed_factor = n;
}
cfg.seed = resolveSeed(seed);
cfg.media_type = media_type || undefined;
// 读音校对：本次合成的词粒度读音覆盖，仅在非空对象时透传给引擎。
cfg.pron_overrides = (pron_overrides && typeof pron_overrides === "object" && !Array.isArray(pron_overrides) && Object.keys(pron_overrides).length) ? pron_overrides : undefined;
// 逐字语言覆盖，用于共用汉字（{substring -> lang}）。
cfg.lang_overrides = (lang_overrides && typeof lang_overrides === "object" && !Array.isArray(lang_overrides) && Object.keys(lang_overrides).length) ? lang_overrides : undefined;
// 平台自身的键：不写入 payload 与指纹（否则勾选一次会使整份缓存失效），只用于跳过缓存复用。
cfg.force_resynth = !!body.force_resynth;
cfg.launch_weights = (launch_weights && typeof launch_weights === "object" && !Array.isArray(launch_weights) && Object.keys(launch_weights).length) ? launch_weights : undefined;

// method：入口选择，与宿主同口径。多方法引擎（methods 是非空表）请求值必须在表里；
// 单方法引擎（methods === null）服务层不校验，值不同时交给宿主判断。
if (body.method !== undefined && body.method !== null && body.method !== "") {
 if (Array.isArray(engine.methods) && engine.methods.length > 0 && !engine.methods.includes(body.method)) {
  throw new HttpError(400,
   `method '${body.method}' 不在该引擎的方法表中（可用值：${engine.methods.join('、')}）。` +
   `未填写 method 时使用名片的 default_method。请修改请求中的 method，或修改 ${engine.dir}/manifest.json 的 methods。`);
 }
 cfg.method = body.method;
}

// auto（多语种）：无假名的 CJK 回落。基底语言由 lib/langCodes.js 的 resolveBaseLang 解析，两个入口共用那一份：auto 或空解析成一个合法的基底语言成员（默认 zh），历史写法（all_ja）先归一再判，与引擎的 _norm_base_lang 一致。
if (cfg.text_lang === "auto_zh_ja_yue" || cfg.text_lang === "auto_zh_ja") {
 cfg.auto_base_lang = resolveBaseLang(auto_base_lang || voiceReg.language || voiceReg.text_lang);
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
 throw new HttpError(400, `Reference audio is ${seconds.toFixed(1)}s; ${engine.label} requires a ${clip.min}–${clip.max}s reference clip. Choose another slice before generating.`);
 }
}
// 硬校验之二：参数格子非空。规则只认「点名的引擎」与「带的那袋参数」是不是同一台。
// 不认 requires_engine_params：resolveEngineProfile 的返回体里没有这个键，名片写了也不参与这条判断。
// 请求携带其他引擎的参数格子，意味着界面按一台引擎绘制而请求点名另一台；这种错配返回 400，并指出该组参数属于哪台引擎。
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
// 名片为参数标注 phase：load 只在进程启动时读取，其余是调用参数；同一个键不能两处都发送。
const allowedLoad = new Set((engine.param_schema || []).filter((f) => f.phase === 'load').map((f) => f.name));
const requestBoxes = req.body && req.body.engine_params;
const requestBox = requestBoxes && typeof requestBoxes === 'object' && !Array.isArray(requestBoxes)
 ? requestBoxes[engine.id] : null;
if (requestBox && typeof requestBox === 'object' && !Array.isArray(requestBox)) {
 // 参数格子可容纳的键 = 名片的参数格子 ∪ 只进请求体的原生键，再减去平台自行处理的键：maps 的目标键
 // 按 maps 改名后发送，平台的键见 paramTable 的 PLATFORM_REQUEST_KEYS；混入请求体会让引擎收到第二个同名值。
 // 过滤只作用于发送的那一份。
 const gridKeys = new Set((engine.param_schema || []).map((entry) => entry.name));
 {
  const owned = new Set([...Object.values(engine.maps || {}), ...PLATFORM_REQUEST_KEYS]);
  for (const key of (engine.payload_keys || [])) if (!owned.has(key)) gridKeys.add(key);
 }
 const callOnly = {};
 const schemaByName = new Map((engine.param_schema || []).map((entry) => [entry.name, entry]));
 for (const [name, value] of Object.entries(requestBox)) {
 if (allowedLoad.has(name)) {
 if (!Object.prototype.hasOwnProperty.call(engineLoadParams, name)) engineLoadParams[name] = value;
 } else if (gridKeys.has(name)) {
 // 名片声明过的键走与平铺值同一口径的归一：平铺值缺席时，格子里的原值就是发出去的那一份，
 // 不归一等于同一个参数从两个入口进来用两套规则（字符串 "12" 与数字 12 在引擎那边不是同一个请求）。
 const entry = schemaByName.get(name);
 if (!entry || isBlankValue(value)) callOnly[name] = value;
 else {
 const coerced = coerceIncoming(entry, value);
 if (coerced !== undefined) callOnly[name] = coerced;
 }
 }
 }
 // 第四段：参数格子写入 cfg；请求中的分格结构不改写，配方与 meta 记录调用方给出的原始形状。
 cfg.engine_params = callOnly;
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
// 批次靠成员 meta.json 分组重建（见 GET /api/outputs/batches），没有单独的清单文件可与实际结果走偏。
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
 ...carriedOverEntry,
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
  // 走 stdio 的引擎（名片推出的 transport）一律要过这一步：它只能由后端按需拉起，管道也只在 supervisor 手里。
 if (engineSupervisor && (usesStdio(engine) || launchSlots(engine).length > 0 || Object.keys(engineLoadParams).length > 0)) {
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
 'ENGINE_LOAD_FAILED',
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
 return { ok: true, id: genId, voice, split: false, concat: false, engine_batch: engineBatch, audio_url: audioUrl, seed: cfg.seed,
 ...carriedOverEntry };
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
 ...carriedOverEntry,
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
 ...carriedOverEntry,
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
