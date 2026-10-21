'use strict';

// 合成核心：拼请求体、切权重、逐段推理、种子与参考音频解析。
// _modelSwitcher（同模型复用，跳过多余的 /set_*_weights）与 segmentCache（分段结果复用）
// 由 server.js 构造一次后注入，本模块不自己 new。

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
  // 种子解析：把随机种子请求（-1 / 空 / null / 非法）换成一个具体的 [0, 2^32-1] 范围内的整数；
  // 合法的非负整数原样透传。在写 meta.json 之前就定下来，落盘的种子就是实际用的那个。
  function resolveSeed(seed) {
    const n = typeof seed === "number" ? seed : parseInt(seed, 10);
    return (Number.isInteger(n) && n >= 0) ? n : Math.floor(Math.random() * 0x100000000);
  }

  // 平台的活：把「参考音频/参考文本」解析成本机磁盘上真实存在的东西，与引擎无关。
  // 返回的是平台的词（reference_audio / reference_text），不是任何引擎的键名：读引擎自己的键名，
  // 在一台不叫这个名字的引擎上会拿到 undefined，静默失败。
  function resolveReference(cfg) {
    let refAudio = cfg.reference_audio || "";
    let refText = cfg.reference_text || "";

    // 没配参考音频时，从资产里自动取第一条匹配到的切片。
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

    // 相对路径转绝对路径：引擎是独立进程，工作目录与本进程不同，相对路径过去就找不到文件。
    if (refAudio && !refAudio.includes(":\\") && !refAudio.startsWith("/")) {
      refAudio = resolveRefPath(refAudio);
    }

    return { reference_audio: refAudio, reference_text: refText };
  }

  // 拼请求体：平台备料，名片说怎么摆。engine 必传，不传当场抛：可选的引擎参数会让每个新调用点
  // 都能忘了传，而忘了传不报错，报出来的却是另一台引擎的原话。
  // @param {string} text     要合成的文本
  // @param {object} cfg      合成配置（键名是历史遗留的形状）
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

    // 平台的词。右边这些 cfg 字段名是历史遗留的形状，但它们是平台内部配置对象的字段，不是发出去的键名。
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

    // 辅助参考音频转绝对路径：与主参考音频同样解析，不依赖引擎的 cwd 恰好等于 APP_DIR。
    // 键名问名片要，不写死。没有这个概念的引擎（maps 里没这一行）整段跳过，而不是塞一个它看不懂的键。
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

  async function switchModels(cfg, engine) {
    // 切权重必须成功后才推理：失败则抛错，避免静默地用旧/半加载模型合成。
    // 同模型合并由共享的 ModelSwitcher 负责：请求的权重已经在引擎里时，跳过 /set_*_weights 这一轮往返。
    // engine = 这次请求解析出来的名片。换权重是发给这一台的请求，地址必须跟着走：不跟着走的后果
    // 不是「落到默认那台」，而是客户端当场抛 ENGINE_BASE_URL_MISSING。
    return _modelSwitcher.ensure(cfg, engine || null);
  }

  async function generateOneSegment(segmentText, cfg, engine, out = {}) {
    const payload = buildTtsPayload(segmentText, cfg, engine);
    // 辅助参考音频在 buildTtsPayload 里已经解析成绝对路径并按存在性过滤过，
    // 别在这里把 cfg 里的原值再塞回去，那会把解析好的路径打回项目相对路径。
    // 名片门控：这台引擎的 payload_keys 上没有这个键就不发，通用宿主对不认识的键
    // 直接 400（lib/engines/host.py），硬塞过去等于必然失败。
    const _profile = engine;
    applyEngineKnobs(payload, _profile, cfg);

    // 复用缓存的取值点就在这里，位置是刻意的：payload 已经拼完（buildTtsPayload + applyEngineKnobs
    // 都过了），马上就要发出去。这一刻 payload 里有且仅有这次推理的全部输入，指纹它，
    // 「漏一个键」在构造上就不可能发生。
    // 别把这段搬到 synthesisService 的分段循环里：那里手上只有 cfg，得自己再拼一次 payload，那就是
    // 第二条装配线，迟早和真的这条漂开，而漂开的症状是返回一段错的音频且不报错。
    // out 是出参不是返回值：改返回值形状会拖下水所有测试用的假 generateOneSegment。
    return await inferWithCache(
      segmentCache,
      { profile: _profile, payload, cfg },
      () => _inferOneSegment(payload, cfg, engine, _profile),
      out,
    );
  }

  // 真正去推理这一段（缓存未命中时才会被调用）。
  async function _inferOneSegment(payload, cfg, engine, _profile) {
    // 引擎跟着请求走：谁发过来的 engine，就发到谁的地址、用谁的超时。
    // 传输层失败要单独接：ECONNREFUSED 原样抛出来既没有 upstreamBody 也没有引擎身份，会落到通用兜底，
    // 用户只看到 "Internal server error"。
    let ttsRes;
    try {
      // 一律用 _profile（= 必传的 engine）：落到哪台在这一行看得见，也能被日志和报错点名。
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
    // 交出去的是引擎原样吐回来的字节，不是 toPcm16Wav 之后的。存进缓存的也就是这一份：指纹算的是
    // payload（引擎的输入），条目就该是引擎的输出，一进一出对得上。转码是调用方的事。
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
