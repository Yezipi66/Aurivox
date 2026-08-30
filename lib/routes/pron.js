// ===========================
//  ROUTES: Advanced params + pronunciation lexicon
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");

const { resolveLegacyDefaultProfile } = require("../engines/legacyDefault");

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { clientError, gsvPost, loadAdvancedParams, loadPronLexicon, requireApiKey, saveAdvancedParams, savePronLexicon } = ctx;

router.get("/api/advanced-params", (req, res) => {
  res.json(loadAdvancedParams());
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
    // ⭐ 刀 2：这里过去是 `gsvPost("/pron/preview", {...})` —— 不带地址，
    //   于是落到 gsv/client.js 里那个**看不见的**模块级默认（9880）。
    //   `/pron/preview` 本来就是那一台引擎的私有接口（读音校对），所以落到
    //   它身上没错；错的是「落到谁身上」这件事藏在另一个文件的默认值里。
    //   现在在调用处显式解析、显式传：这条路今天绑在谁身上，看得见。
    //   ⚠ 这是老路径仅剩的一处显式 legacy 依赖。等读音校对改成按名片
    //     声明的能力来走时，这三行连同 legacyDefault.js 一起删。
    const _pronProfile = resolveLegacyDefaultProfile();
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
