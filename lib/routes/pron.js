//  ROUTES: Advanced params + pronunciation lexicon
// Read/write of advanced params and the pronunciation lexicon, and the pron
// preview call that must go to the engine the user currently has selected.
// Shared server-scope symbols come in via `ctx`; server.js mounts this with
// app.use(createRouter(ctx)).

const express = require("express");

const { resolveEngineProfile: _resolveEngineProfile } = require("../engines/profile");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const resolveEngineProfile = ctx.resolveEngineProfile || _resolveEngineProfile;
  const { clientError, gsvPost, loadAdvancedParams, loadPronLexicon, requireApiKey, saveAdvancedParams, savePronLexicon } = ctx;

// ?engine_id= 决定「没拧过的格子回落到谁的名片默认值」。
//  不传 ⇒ 不回落到任何一台，只吐盘上真的存过的那些键。
//  少一个键 ≠ 值是 0：它的含义是「用户没拧过这一格，去问那台引擎」。
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
    // 预览跟随当前选中的引擎，不跟随任何一台被钦定的默认引擎：
    //  钦定默认引擎会让读音预览永远打给那台，不管用户当前在用哪台引擎。
    //
    //  判据来自引擎自己的源码注释（lib/inference/infer_server.py 的 pron_preview）：
    //  「复用引擎已加载的 g2pW，保证预览读音 == 实际合成读音」
    //  ⇒ 读音校对这件事概念上是通用的，但它的价值全部来自
    //  「预览的 g2p == 合成的 g2p」这个等号。
    //  ⇒ 换一台引擎去预览，读出来可能也对，但它回答的不是当前选中那台引擎的读音。
    //
    //  落成三条：
    //  ① 预览跟随当前选中的引擎（engine_id 必传）。
    //  ② 「这台能不能预览」是问出来的，不是名片声明的，
    //  那台答 /pron/preview 就有，答不了（404/502）界面自己灰掉。
    //  不加 supports_pron_preview 这类字段（同 §5.9：端口数是算出来的
    //  不是声明的）。
    //  ③ 绝不回落到另一台引擎的 g2p：那会给出一个看起来对、
    //  但和实际合成不一致的读音，而且不报错。宁可没有这个功能。
    const engineId = (body.engine_id || "").toString().trim();
    if (!engineId) {
      return res.status(400).json({
        error: "pron preview requires engine_id：读音预览必须跟随当前引擎进行，" +
               "平台不代为选择（换一台预览出来的读音和实际合成的不是一回事）。",
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
