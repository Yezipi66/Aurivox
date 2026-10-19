'use strict';

// ============================================================================
//  合成核心：拼请求体、切权重、逐段推理、种子与参考音频解析
// ============================================================================
//
// 从 server.js 逐字搬来（P0 拆分任务 4），行为零变化。
//
// 两个服务端单例作为依赖注入，而不是在本模块里 new 一遍：
//   _modelSwitcher  同模型复用（跳过多余的 /set_*_weights）
//   segmentCache    分段结果复用
// 它们仍然只在 server.js 里构造一次，构造时机一个字节都没动。
// 参数名沿用它们在 server.js 里的名字，好让搬过来的函数体逐字不变。

const fs = require('fs');
const path = require('path');

const PATHS = require('../paths');
const { gsvPost } = require('../gsv/client');
const { assembleEnginePayload, engineKey } = require('../engines/payload');
const { applyEngineKnobs } = require('../engines/paramTable');
const { inferWithCache } = require('../cache/cachedInference');
const { upstreamFailure, emptyAudioFailure, isTransportError, transportFailure } = require('../engines/upstreamError');
const pathResolver = require('../pathResolver');
const { resolveRefPath } = require('./paths');

// 语义别名，与 server.js 里那一个同名（都指向 lib/paths.js 的 ASSETS_ROOT）。
const ASSETS_DIR = PATHS.ASSETS_ROOT;

function createSynthesisModule({ _modelSwitcher, segmentCache }) {
  // ===========================
  //  TTS PAYLOAD BUILDER
  // ===========================

  // 契约 v2 第 1c 步：这张表搬去名片了。
  //
  // 它原来叫 TTS_PASS_THROUGH_KEYS，23 个键，全是 GPT-SoVITS 的词汇，
  // 躺在平台代码里。现在的唯一来源是 engines/gpt-sovits/manifest.json 的
  // payload_keys（逐字搬过去，一个没加一个没减）。
  //
  // 它整个删掉了（连同 ctx 里那一项）：全仓只有 buildTtsPayload 读过它，
  // 没有任何路由从 ctx 里取用。留一个空壳"以后可能有人要"就是制造死代码，
  // 这一刀的前一刀刚被死代码咬过一次（requires_engine_params），不重犯。

  // Reproducibility: turn a random-seed request (-1 / empty / null / invalid) into a
  // CONCRETE seed in the engine's range [0, 2^32-1]. Resolving here — before the engine
  // call AND before writing meta.json — means the exact seed used is recorded, so a later
  // Rerun replays the identical value and re-synthesises with that same seed. A valid
  // non-negative integer is passed through unchanged. Mirrors the engine's set_seed(-1)
  // randomisation range, so behaviour is unchanged except the value is now captured
  // instead of lost.
  // Replaying the same seed does NOT yield a byte-identical file — measured ~-88 dB of
  // float jitter on otherwise identical input. This comment previously claimed it
  // "reproduces the same audio"; see the measurement note in lib/services/synthesisService.js.
  function resolveSeed(seed) {
    const n = typeof seed === "number" ? seed : parseInt(seed, 10);
    return (Number.isInteger(n) && n >= 0) ? n : Math.floor(Math.random() * 0x100000000);
  }

  // A-1 那个 batch_size 旋钮（AURIVOX_TTS_BATCH_SIZE，低显存 GPU 降回 1）
  // 已搬到名片的 defaults_env 上，判断逐条一致（int / 1..16 / 不合法就回落）。
  // 这里原来的 _DEFAULT_TTS_BATCH_SIZE 已删除而不是留着兜底，契约 §12：
  // 一刀结束时老写法必须已经不存在，两份一起跑就是下一次漂移的起点。

  // ---------------------------------------------------------------------------
  //  平台的活：把「参考音频/参考文本」解析成本机磁盘上真实存在的东西
  // ---------------------------------------------------------------------------
  // 这一段和引擎无关，任何引擎都需要「给我一条能打开的音频路径」。它过去和
  // 拼请求体的代码搅在同一个函数里，所以看不出哪一半是平台的、哪一半是
  // GPT-SoVITS 的。第 1c 步把它单拎出来，是为了让割线看得见。
  //
  // 返回的是平台的词（reference_audio / reference_text），不是任何引擎的
  // 键名。调用方（synthesisService）过去读的是 .ref_audio_path / .prompt_text，
  // 那两个名字在一台不叫这个名字的引擎上会拿到 undefined，静默失败。
  function resolveReference(cfg) {
    let refAudio = cfg.reference_audio || "";
    let refText = cfg.reference_text || "";

    // If no reference audio configured, auto-pick first matched segment from assets
    if (!refAudio) {
      try {
        const segFile = path.join(ASSETS_DIR, cfg.id || cfg.voiceId || "", "segments.json");
        if (fs.existsSync(segFile)) {
          const segData = JSON.parse(fs.readFileSync(segFile, "utf-8"));
          const first = (segData.segments || []).find(s => s.matched && (s.audio || s.audio_path || s.audio_filename));
          if (first) {
            const raw = first.audio || first.audio_path || first.audio_filename;
            if (raw) {
              refAudio = resolveRefPath(raw);
            }
            if (first.text) refText = first.text;
          }
        }
      } catch (e) { console.error("[TTS] Failed to auto-ref:", e.message); }
    }

    // 相对路径转绝对路径。引擎是独立进程（多数还是另一个 Python 环境），它的
    // 工作目录和我们不是一回事，相对路径过去就是找不到文件。
    if (refAudio && !refAudio.includes(":\\") && !refAudio.startsWith("/")) {
      refAudio = resolveRefPath(refAudio);
    }

    return { reference_audio: refAudio, reference_text: refText };
  }

  // 这里过去有 legacyEngineProfile()，没传 engine 的
  // 调用方，替它去解析「名片上写 legacy_default 的那台」。已删。
  //
  // 它的问题不是"取自哪台"，是它让 `engine` 这个参数看起来可选。
  // 一个可选的引擎参数，意味着每个新调用点都可以忘了传，而忘了传不报错，
  // 报出来的是另一台引擎的原话。
  // buildTtsPayload 的 engine 变必传，不传当场抛。
  // 不回落、不给默认、不留 `engine || 什么什么`。

  // ---------------------------------------------------------------------------
  //  拼请求体：平台备料，名片说怎么摆
  // ---------------------------------------------------------------------------
  // @param {string} text     要合成的文本
  // @param {object} cfg      合成配置（键名是历史形状，见文件末尾的"遗留词汇"说明）
  // @param {object} engine   resolveEngineProfile 的产物。必传。
  function buildTtsPayload(text, cfg, engine) {
    if (!engine) {
      throw new Error(
        "buildTtsPayload: engine is required — 平台没有默认引擎。" +
        " 调用方必须先解析出这次要打哪一台（resolveEngineProfile(engine_id)）。"
      );
    }
    const profile = engine;
    const { reference_audio, reference_text } = resolveReference(cfg);

    // 平台的词。右边这些 cfg 字段名是历史遗留的 GSV 形状，
    // 但它们是平台内部配置对象的字段，不是发出去的键名。
    // 把 cfg 本身改成平台词汇是下一刀的事（见 CFG_LEGACY_FIELDS 的说明）。
    const canonical = {
      text,
      text_lang: cfg.text_lang || cfg.language || "ja",
      reference_audio,
      reference_text,
      reference_lang: cfg.prompt_lang || cfg.language || "ja",
      speed: cfg.speed_factor,
      seed: cfg.seed,
      media_type: cfg.media_type,
      aux_reference_audio: cfg.aux_ref_audio_paths,
    };

    const payload = assembleEnginePayload({
      profile,
      canonical,
      cfg,
      engineParams: cfg.engine_params,
    });

    // Auxiliary references → absolute paths: resolve each aux entry the
    // SAME way as the main reference so live generate no longer relies on the
    // engine's cwd coinciding with APP_DIR. Accepts legacy strings and v3
    // { base, path } objects; drops anything missing on this machine.
    // 键名问名片要，不再写死。没有这个概念的引擎（maps 里没这一行）
    // 整段跳过，而不是往请求体里塞一个它看不懂的键。
    const auxKey = engineKey(profile, "aux_reference_audio");
    if (auxKey && Array.isArray(payload[auxKey]) && payload[auxKey].length) {
      payload[auxKey] = payload[auxKey]
        .map((p) => {
          if (p && typeof p === "object") {
            const r = pathResolver.resolveManagedRef(p, {});
            return r.ok ? r.path : "";
          }
          return resolveRefPath(p);
        })
        .filter((p) => p && fs.existsSync(p));
      if (payload[auxKey].length === 0) delete payload[auxKey];
    }

    return payload;
  }

  // ===========================
  //  GENERATION CORE
  // ===========================

  async function switchModels(cfg, engine) {
    // 切权重必须成功后才推理: 失败则抛错, 避免静默地用旧/半加载模型合成 (错声音/异常)。
    // Point 4 — same-model coalescing: delegate to the shared ModelSwitcher, which
    // skips the /set_*_weights round-trip when the requested weights are already
    // resident. Behaviour on a first/changed request or on failure is identical
    // to the previous inline implementation (same thrown Error messages). Safe
    // because switchModels is only ever called under withGenerationLock.
    // engine = 这次请求解析出来的名片。换权重是发给这一台的请求，
    // 地址必须跟着走。不跟着走的后果不是"落到默认那台"，而是客户端当场
    // 抛 ENGINE_BASE_URL_MISSING，前端只看得到 "Internal server error"。
    // （界面上选好音色一按生成就 500，一声不出。）
    return _modelSwitcher.ensure(cfg, engine || null);
  }

  async function generateOneSegment(segmentText, cfg, engine, out = {}) {
    const payload = buildTtsPayload(segmentText, cfg, engine);
    // 辅助参考音频在 buildTtsPayload 里已经解析成绝对路径并按存在性过滤过
    // 别在这里把 cfg 里的原值再塞回去，那会把解析好的路径
    // 打回项目相对路径，live generate 就找不到文件了。
    //
    // 补一次是因为白名单那一段会把空串/null 过滤掉，而布尔 false 必须显式送达
    // （不发和发 false 在引擎那边是两件事）。
    // 第 1c 步加了名片门控：这台引擎的 payload_keys 上没有这个键就不发。
    // 通用宿主对不认识的键直接 400（lib/engines/host.py:637-645），
    // 硬塞过去等于必然失败。
    // C11：原来这里写死补 ["sample_steps","if_sr"] 两个键，那是 GPT-SoVITS
    //   的私有参数名。现在补的是「这台引擎名片上声明的全部旋钮」，所以下游引擎
    //   的布尔参数不会再在这一行上被静默丢掉。
    // 这里过去是 `engine || legacyEngineProfile()`。engine 现在必传，
    // 而且上面 buildTtsPayload 已经先替我们把「没传」拦成异常了。
    const _profile = engine;
    applyEngineKnobs(payload, _profile, cfg);

    // 复用缓存的取值点就在这里，位置是刻意的：payload 已经拼完
    // （buildTtsPayload + applyEngineKnobs 都过了），马上就要发出去。
    // 这一刻 payload 里有且仅有这次推理的全部输入。指纹它，「漏一个键」
    // 在构造上就不可能发生。
    //
    // 别把这段搬到 synthesisService 的分段循环里：那里手上只有 cfg，
    // 得自己再拼一次 payload，那就是第二条装配线，迟早和真的这条漂开，
    // 而漂开的症状是返回一段错的音频且不报错。
    //
    // 收益（640 字 / 30 段 / 3070 Laptop）：改一句话 45.6 秒 → 3.9 秒。
    // 策略本身在 lib/cache/cachedInference.js，这里只有接线。理由：这几行
    // 是全仓出错代价最高的代码之一（算错了不报错，只是让用户听到上一次的
    // 音频），而 server.js 是全仓唯一进不了测试进程的文件（一 require 就
    // app.listen）。所以策略放到能被测试直接调用的地方去。
    //
    // out 是出参不是返回值：盘上有 8 个假 generateOneSegment（各测试的
    // harness），改返回值形状会把它们全部拖下水，而出参对它们完全透明。
    // 它们不写 out，调用方读到的就是 undefined，即「不知道是否命中」。
    return await inferWithCache(
      segmentCache,
      { profile: _profile, payload, cfg },
      () => _inferOneSegment(payload, cfg, engine, _profile),
      out,
    );
  }

  // 真正去推理这一段（缓存未命中时才会被调用）。
  async function _inferOneSegment(payload, cfg, engine, _profile) {
    // 引擎跟着请求走（契约 v2 第 1b 步）：
    // 谁发过来的 engine，就发到谁的地址、用谁的超时。
    // engine 为空 = 老调用方，gsvPost 自己懒解析老路径名片，行为不变。
    // 第 3 步（甲）：错误文案里的引擎名改为从名片来（_profile 就在上面几行）。
    // 老路径引擎的 label 就是 "GPT-SoVITS"，所以对今天的用户这句话一个字节
    // 都没变；接了别的引擎时才会说出那台的名字。
    // 承重的部分（上游报错怎么传到 synthesisService）已经从「文案 + 正则」搬到
    // err.upstreamBody 属性上了，见 lib/engines/upstreamError.js 的注释。
    // 传输层失败要单独接：gsvPost 内部是 `req.on("error", reject)`
    //   （lib/gsv/client.js:69），Node 的 ECONNREFUSED 原样抛出来，既没有
    //   upstreamBody 也没有引擎身份 ⇒ 一路落到通用兜底，用户只看到
    //   "Internal server error"，而日志里写着 connect ECONNREFUSED 127.0.0.1:9880。
    //   引擎未启动时就是这样。这是新用户与下游插件作者最容易
    //   撞上的第一个错误，恰恰是唯一不点名引擎的那个。
    let ttsRes;
    try {
      // 这里过去是 `engine ? {...} : undefined`，不带 engine 时把
      // 「连哪台」交给 gsvPost 里那个懒解析的模块级默认值（永远是名片上写
      // legacy_default 的那台，9880）。那是一次看不见的改道：调用方以为
      // 自己没指定地址，实际上指定了，而且指定的是别人。
      // 现在一律用 _profile（= 必传的 engine），
      //   落到哪台在这一行看得见，也能被日志和报错点名。
      ttsRes = await gsvPost("/tts", payload,
        { baseUrl: _profile.base_url, reqTimeout: _profile.timeout_ms });
    } catch (err) {
      if (isTransportError(err)) {
        throw transportFailure(_profile, err,
          { baseUrl: (engine && engine.base_url) || _profile.base_url });
      }
      throw err;
    }
    if (ttsRes.statusCode >= 400) {
      throw upstreamFailure(_profile, ttsRes.statusCode, ttsRes.body.toString());
    }
    const audioBytes = ttsRes.body;
    if (!audioBytes || audioBytes.length === 0) {
      throw emptyAudioFailure(_profile);
    }
    // 交出去的是引擎原样吐回来的字节，不是 toPcm16Wav 之后的。存进缓存的
    //   也就是这一份。理由：指纹算的是 payload（引擎的输入），那么条目就该是引擎
    //   的输出，一进一出对得上。转码是调用方的事，命中时它照样会再转一次，
    //   行为与 miss 时一模一样。
    return audioBytes;
  }

  return {
    resolveSeed,
    resolveReference,
    buildTtsPayload,
    switchModels,
    generateOneSegment,
  };
}

module.exports = { createSynthesisModule };
