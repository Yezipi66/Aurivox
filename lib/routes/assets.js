// 资产相关的路由装配。处理函数按路由组拆到 ./assets/ 下，这里只负责注册。
// 注册顺序与拆分前一致：Express 按注册顺序匹配，字面量路径必须排在参数路径
// 之前，否则会被当成参数。

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
