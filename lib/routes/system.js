// ===========================
//  ROUTES: System (health, model status)
// ===========================
// Extracted from server.js (Stage-1 refactor). Route handler bodies are
// unchanged; shared server-scope symbols are injected via `ctx`. Mounted
// in server.js via app.use(createRouter(ctx)). Full paths are preserved.

const express = require("express");
// ⭐ 逐台健康**复用** /api/engines 那份探活，不在这里另写一个。
//   engines.js:33 那句注释早就把这个复用点标出来了：「两处各写一遍探活，
//   迟早会在超时值或判定条件上分叉」。分叉的后果是界面上两个地方对同一台
//   引擎给出不同的死活，而没有任何一处能说清哪个是真的。
const { listEngines } = require("../engines/registry");
const { resolveEngineProfile } = require("../engines/profile");
const { probeEngineOnline } = require("./engines");

// 逐台健康 —— 契约 §12 第 2 步，刀 1 第 ⑤ 条。
//
// ⛔ **只增不改 → 退役过渡**（刀 A5，2026-09-01）：`engine_online` 与 `gpt_sovits_url`
//    两个老字段响应里**仍原样保留**（取值方式不动），但已标记退役 —— 前端 web/src/
//    已零消费（原 App.jsx:73,150 是过时引用，见 git 历史）。等价信息（逐引擎 URL+在线态）
//    由新键 `engines[].base_url` / `engines[].online` 承载。响应新增 `deprecated` 数组
//    点名这两个字段 + 迁移目标，前端/脚本据此迁，不再读上两个。老字段至少保留一个版本。
//
// ⚠ 于是同一台老引擎会被探两次（老字段一次、列表里一次）。这不是疏忽：
//    老字段的含义必须**完全不依赖**名片体系，否则哪天谁把 manifest.json 的
//    逗号写错，表现出来就是「webui 说引擎掉线了」—— 一个和真相无关的红点。
//    多打一次 HTTP 换老字段的含义不被新东西污染，值。
//
// ⚠ 与 /api/engines 的一处**故意的不一致**：那边名片坏掉会 500（它的职责就是
//    回答「装了哪几台」，答不出就该说答不出）；这边**绝不 500** ——
//    健康接口的职责是**保持能答话**。所以名片出问题只会让 engines 变空、
//    errors 里多几条，ok 仍然是 true。
async function listEngineHealth() {
  let manifests;
  try {
    manifests = listEngines();
  } catch (err) {
    // 扫目录整个挂了。⛔ 不能装作「一台都没装」—— 那会让一个语法错误
    //   表现为引擎集体消失，而不是「引擎目录读不了」。
    return { engines: [], errors: [{ id: null, code: (err && err.code) || null,
      error: `列举引擎失败：${(err && err.message) || err}` }] };
  }
  const resolved = [];
  const errors = [];
  for (const m of manifests) {
    try {
      resolved.push(resolveEngineProfile(m.id));
    } catch (err) {
      // ⛔ 不静默跳过：一台名片写坏了要看得见，不能表现为「这台不存在」。
      errors.push({ id: m.id, code: (err && err.code) || null,
        error: (err && err.message) || String(err) });
    }
  }
  // 并行。串行的话总耗时是各台超时之和，装 5 台就是 10 秒 —— 健康接口
  // 挂十秒，监控会把它当成宕机。
  const probes = await Promise.all(resolved.map((p) => probeEngineOnline(p)));
  return {
    engines: resolved.map((p, i) => ({
      id: p.id,
      label: p.label,
      // 「连」的地址（会被名片声明的 env 顶掉），⛔ 不是 default_base_url
      //   那个「听」的地址 —— 探活探的是「我现在能不能连上它」。
      base_url: p.base_url,
      // ⭐ 三态，⛔ 不是布尔：null = 名片没写 runtime.ready_endpoint，平台
      //   不知道该访问哪儿判断死活。「不知道」和「确定离线」糊成同一个
      //   假值之后，界面上那个灰点就再也说不清是哪一种了（engines.js:40）。
      online: probes[i].online,
    })),
    errors,
  };
}

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { GPT_SOVITS_BASE_URL, checkBaseModelsForVersion, checkFfmpeg, detectCuda, http, normModelVersion, noteEngineHealth } = ctx;
  // The engine base URL is resolved once from the same env var / default the
  // rest of the backend uses (GPT_SOVITS_BASE_URL). Health MUST NOT hard-code
  // 127.0.0.1:9880 — when start.ps1 shifts the engine port off a busy 9880 it
  // exports GPT_SOVITS_BASE_URL, and a hard-coded probe would then永远误报
  // engine_online:false. Fall back to the historical default only if unset.
  const ENGINE_URL = (GPT_SOVITS_BASE_URL || "http://127.0.0.1:9880").replace(/\/+$/, "");

  // App version surfaced in /api/health (1.0.7) — read from package.json so it
  // tracks releases without a hard-coded string.
  let APP_VERSION = "0.0.0";
  try { APP_VERSION = require("../../package.json").version || APP_VERSION; } catch (_) {}

router.get("/api/health", async (req, res) => {
  let engine_online = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(`${ENGINE_URL}/`, { signal: ctrl.signal });
    clearTimeout(t);
    engine_online = r.ok;
  } catch { engine_online = false; }
  // Feed liveness to the model-switch cache: an offline->online flip means the
  // engine restarted and lost its resident weights, so the cache is invalidated
  // (guarded so unit harnesses without this hook don't break).
  if (typeof noteEngineHealth === "function") noteEngineHealth(engine_online);
  // 逐台健康（⑤）。⛔ 它整个失败也不许把 /api/health 带塌 —— 健康接口
  //   答不出话，比它报告的任何一个坏消息都严重。
  let per = { engines: [], errors: [] };
  try {
    per = await listEngineHealth();
  } catch (err) {
    per = { engines: [], errors: [{ id: null, code: (err && err.code) || null,
      error: `逐台健康失败：${(err && err.message) || err}` }] };
  }
  res.json({
    ok: true,
    version: APP_VERSION,
    // ⬇ 老字段，**已退役**（2026-09-01 刀 A5）。前端 web/src/ 已零消费，
    //   等价信息（逐引擎 URL+在线态）由下面的 engines[] 承载。
    //   出于「只增不改」纪律，保留至少一个版本作别名，⛔ 新代码不许再读。
    //   退役清单见 response.deprecated 字段。
    engine_online,          // RETIRED — see response.deprecated
    gpt_sovits_url: ENGINE_URL, // RETIRED — use engines[].base_url instead
    // ⬇ 退役公告：列出哪些字段已弃用、迁往何处。前端/脚本应据此迁移，不再读上两个。
    deprecated: [
      { key: 'engine_online', use: 'engines[].online', since: APP_VERSION },
      { key: 'gpt_sovits_url', use: 'engines[].base_url', since: APP_VERSION },
    ],
    // ⬇ 装了哪几台、各自连哪儿、各自活没活（替代上面两个老字段）
    engines: per.engines,
    engine_errors: per.errors,
    ffmpeg_available: checkFfmpeg(),
    // ⚠️ 键名仍叫 `cuda`：前端 web/src/App.jsx:261 与 TrainingTab 四处在读它，
    //   改键名要一起改前端 ⇒ 是**一件独立的小活**，不在这次范围里。
    //   ⛔ 但字段的含义已经变了：以前是「那个 venv 里的 torch 说没有就没有」，
    //     现在是「这台机器有什么」。有 Intel/AMD 卡而没有 N 卡时，
    //     device_name 有值而 available=false —— **那不再是故障，是一个真实状态**。
    cuda: detectCuda(),
  });
});

router.get("/api/models/status", (req, res) => {
  const raw = req.query.versions != null ? String(req.query.versions)
            : (req.query.version != null ? String(req.query.version) : 'v2');
  const seen = new Set(); const versions = [];
  for (const tok of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const nv = normModelVersion(tok);
    if (!seen.has(nv)) { seen.add(nv); versions.push(checkBaseModelsForVersion(nv)); }
  }
  if (!versions.length) versions.push(checkBaseModelsForVersion('v2'));
  const anyBlocking = versions.some((v) => v.blocking);
  const anyDegraded = versions.some((v) => v.degraded);
  // 顶层铺开首个版本字段，兼容旧前端单版本读法。
  res.json({ versions, anyBlocking, anyDegraded, ...versions[0] });
});

  return router;
};
