// ===========================
//  ROUTES: Advanced params + pronunciation lexicon
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

const { resolveEngineProfile: _resolveEngineProfile } = require("../engines/profile");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const resolveEngineProfile = ctx.resolveEngineProfile || _resolveEngineProfile;
  const { clientError, gsvPost, loadAdvancedParams, loadPronLexicon, requireApiKey, saveAdvancedParams, savePronLexicon } = ctx;

// ⭐ 刀 A1：?engine_id= 决定「没拧过的格子回落到谁的名片默认值」。
//   ⛔ 不传 ⇒ **不回落到任何一台**，只吐盘上真的存过的那些键。
//   ⚠ 少一个键 ≠ 值是 0：它的含义是「用户没拧过这一格，去问那台引擎」。
router.get("/api/advanced-params", (req, res) => {
  const engineId = (req.query.engine_id || "").toString().trim();
  res.json(loadAdvancedParams(engineId));
});

router.post("/api/advanced-params", requireApiKey, (req, res) => {
  try {
    const merged = saveAdvancedParams(req.body || {});
    res.json({ ok: true, params: merged });
  } catch (err) {
    res.status(500).json({ error: clientError(err) });
  }
});

router.post("/api/pron/preview", async (req, res) => {
  const body = req.body || {};
  const text = (body.text || "").toString();
  const lang = (body.lang || "zh").toString();
  if (!text) return res.json({ lang, norm_text: "", tokens: [] });
  try {
    // ⭐⭐⭐ 刀 A1（Owner 2026-08-31 12:22 裁决④）：这里过去是
    //   `resolveLegacyDefaultProfile()` —— 读音预览永远打给「名片上写
    //   legacy_default 的那台」，不管用户当前在用哪台引擎。**已删。**
    //
    //   判据来自引擎自己的源码注释（lib/inference/infer_server.py:574）：
    //       「复用引擎已加载的 g2pW，保证预览读音 == 实际合成读音」
    //   ⇒ 读音校对这件事概念上是通用的，但它的价值**全部**来自
    //     「预览的 g2p == 合成的 g2p」这个等号。
    //   ⇒ **换一台引擎去预览，读出来可能也对，但它已经不再回答原来那个问题了。**
    //
    //   落成三条：
    //     ① 预览跟着**当前选中的那台引擎**走（engine_id 必传）。
    //     ② 「这台能不能预览」是**问出来的**，不是名片声明的 ——
    //        那台答 /pron/preview 就有，答不了（404/502）界面自己灰掉。
    //        ⛔ 不加 supports_pron_preview 这类字段（同 §5.9：端口数是算出来的
    //        不是声明的）。
    //     ⛔⛔ ③ **绝不回落到另一台引擎的 g2p** —— 那会给出一个看起来对、
    //        但和实际合成不一致的读音，而且不报错。宁可没有这个功能。
    const engineId = (body.engine_id || "").toString().trim();
    if (!engineId) {
      return res.status(400).json({
        error: "pron preview requires engine_id — 读音预览必须跟着当前引擎走，" +
               "平台不替你挑一台（换一台预览出来的读音和实际合成的不是一回事）。",
        code: "PRON_ENGINE_ID_MISSING",
      });
    }
    let _pronProfile;
    try {
      _pronProfile = resolveEngineProfile(engineId);
    } catch (err) {
      return res.status(400).json({ error: clientError(err, `unknown engine '${engineId}'`) });
    }
    const r = await gsvPost("/pron/preview", { text, lang },
      { baseUrl: _pronProfile.base_url, reqTimeout: _pronProfile.timeout_ms });
    let payload;
    try { payload = JSON.parse(r.body.toString("utf-8")); }
    catch (e) { payload = { message: "bad preview response" }; }
    return res.status(r.statusCode || 200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: clientError(e, "pron preview failed (engine offline?)") });
  }
});

router.get("/api/pron/lexicon", (req, res) => {
  const lang = (req.query.lang || "zh").toString();
  return res.json({ lang, entries: loadPronLexicon(lang) });
});

router.post("/api/pron/lexicon", requireApiKey, (req, res) => {
  const body = req.body || {};
  const lang = (body.lang || "zh").toString();
  const word = (body.word || "").toString().trim();
  const pinyins = Array.isArray(body.pinyins) ? body.pinyins.map(String) : null;
  if (!word) return res.status(400).json({ error: "Missing 'word'" });
  if (!pinyins || !pinyins.length) return res.status(400).json({ error: "Missing 'pinyins'" });
  try {
    const data = loadPronLexicon(lang);
    data[word] = pinyins;
    savePronLexicon(lang, data);
    return res.json({ ok: true, lang, word, pinyins, entries: data });
  } catch (e) {
    return res.status(500).json({ error: clientError(e, "save lexicon failed") });
  }
});

router.delete("/api/pron/lexicon", requireApiKey, (req, res) => {
  const body = req.body || {};
  const lang = ((req.query.lang || body.lang) || "zh").toString();
  const word = ((req.query.word || body.word) || "").toString().trim();
  if (!word) return res.status(400).json({ error: "Missing 'word'" });
  try {
    const data = loadPronLexicon(lang);
    delete data[word];
    savePronLexicon(lang, data);
    return res.json({ ok: true, lang, word, entries: data });
  } catch (e) {
    return res.status(500).json({ error: clientError(e, "delete lexicon failed") });
  }
});

  return router;
};
