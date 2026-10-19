// ===========================
// ROUTES: Assets (scan, segments, transcript, transcribe, refine)
// ===========================
// Route handler bodies are unchanged; shared server-scope symbols are injected
// via `ctx`. Mounted in server.js via app.use(createRouter(ctx)). Full paths are
// preserved.
//
// 处理函数按路由组拆到 ./assets/ 下，这里只负责装配。注册顺序与拆分前一致：
// Express 按注册顺序匹配，字面量 /api/assets/voices-with-models 必须排在
// /api/assets/:id 之前，否则会被当成 id。

const express = require("express");

const registerBasic = require("./assets/basic");
const registerModels = require("./assets/models");
const registerCrud = require("./assets/crud");
const registerSegments = require("./assets/segments");
const registerTranscript = require("./assets/transcript");
const registerRebuild = require("./assets/rebuild");
const registerDeriveId = require("./assets/deriveId");
const registerRefine = require("./assets/refine");

module.exports = function createRouter(ctx) {
 const router = express.Router();

 registerBasic(router, ctx);
 registerModels(router, ctx);
 registerCrud(router, ctx);
 registerSegments(router, ctx);
 registerTranscript(router, ctx);
 registerRebuild(router, ctx);
 registerDeriveId(router, ctx);
 registerRefine(router, ctx);

 return router;
};
