//  ROUTES: Advanced params + pronunciation lexicon
// Read/write of advanced params and the pronunciation lexicon, and the pron
// preview call that must go to the engine the user currently has selected.
// Shared server-scope symbols come in via `ctx`; server.js mounts this with
// app.use(createRouter(ctx)).

const express = require("express");

const { resolveEngineProfile: _resolveEngineProfile } = require("../engines/profile");
const { postToEngine } = require("../engines/engineChannel");

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
    // 预览只发给当前选中的引擎（engine_id 必传），不回落到任何默认引擎：
    // 读音校对的价值全部来自「预览的 g2p == 合成的 g2p」，换一台引擎预览会给出
    // 看起来正确、与实际合成不一致的读音，而且不报错。
    //
    // 能力有无只由名片 pron.preview 声明，未声明返回 501；不用 404/502 探测，
    // 探测会把「引擎离线」和「没有这个能力」混成同一句话。
    const engineId = (body.engine_id || "").toString().trim();
    if (!engineId) {
      return res.status(400).json({
        error: "pron preview requires engine_id：读音预览必须跟随当前选中的引擎，" +
               "平台不代为选择（其他引擎的预览读音与实际合成读音不一致）。",
        code: "PRON_ENGINE_ID_MISSING",
      });
    }
    let _pronProfile;
    try {
      _pronProfile = resolveEngineProfile(engineId);
    } catch (err) {
      return res.status(400).json({ error: clientError(err, `unknown engine '${engineId}'`) });
    }
    const preview = _pronProfile.pron_preview;
    if (!preview) {
      return res.status(501).json({
        error: `引擎 '${_pronProfile.id}' 没有声明读音预览能力（manifest.json 的 pron.preview），不支持读音校对。`,
        code: "PRON_PREVIEW_UNSUPPORTED",
      });
    }
    // 走到这里的必然自带 HTTP 服务：通用宿主声明 pron 在解析层就被拒绝
    // （profile.js 的 pron 一节），所以这条调用链不传 supervisor。
    const r = await postToEngine({
      profile: _pronProfile,
      httpPost: gsvPost,
      path: preview.endpoint,
      payload: { text, lang },
    });
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
