// Flow 内核的 HTTP 适配层。只在 FLOW_ENABLED 设置时才挂载，默认部署的路由表不变。
// 薄适配：HTTP 与 FlowRuntime 之间来回翻译，并把内核错误码映射成状态码。
// 调度、合成、Journal 逻辑都不在这里。
//
// 错误映射要显式写出来，不能「什么错都是 500」。映射表本身在
// lib/workflow/errorStatus.js：纯函数。放在本文件会让 Flow 单元测试把 express
// 一起拖进来，依赖缺失时是加载失败而不是跳过。那个文件的头部写了映射理由，
// 以及为什么它必须保持无依赖。

const express = require("express");
const { HttpError, asyncHandler } = require("../http/http");
const { statusFor } = require("../workflow/errorStatus");

// 内核错误带结构化诊断信息，可以直接对外吐：重绑诊断只含摘要和长度，不含明文。
function bodyFor(err) {
  const out = {
    code: (err && err.code) || "FLOW_INTERNAL_ERROR",
    message: (err && err.message) || String(err),
  };
  if (err && err.retryable !== undefined) out.retryable = err.retryable === true;
  if (err && Array.isArray(err.mismatches)) out.mismatches = err.mismatches;
  if (err && Array.isArray(err.conflicts)) out.conflicts = err.conflicts;
  if (err && Array.isArray(err.issues)) out.issues = err.issues;
  // WorkflowValidationError 的逐节点问题清单挂在 `errors` 下。
  // 不带上的话，400 不会告诉调用方是哪个节点错了。
  if (err && Array.isArray(err.errors)) out.errors = err.errors;
  if (err && err.blocked_nodes) out.blocked_nodes = err.blocked_nodes;
  return out;
}

function rethrowAsHttp(err) {
  throw new HttpError(statusFor(err), bodyFor(err));
}

module.exports = function createRouter(ctx) {
  const router = express.Router();
  const { clientError, flowRuntime, requireApiKey } = ctx;

  // 守卫：路由只在有 runtime 时挂载，但这里仍显式返回 503，
  // 万一以后接线变了，也不该变成 TypeError。
  const runtime = () => {
    if (!flowRuntime) {
      throw new HttpError(503, {
        code: "FLOW_DISABLED",
        message: "Aurivox Flow is not enabled on this server (set FLOW_ENABLED=1).",
      });
    }
    return flowRuntime;
  };

  router.get("/api/flow/status", asyncHandler(async () => ({
    ok: true,
    enabled: Boolean(flowRuntime),
    journal_dir: flowRuntime ? flowRuntime.journalDir : null,
    resumable_runs: flowRuntime ? flowRuntime.knownRunIds().length : 0,
  }), clientError));

  router.get("/api/flow/runs", requireApiKey, asyncHandler(async () => {
    const rt = runtime();
    return { ok: true, runs: await rt.listRuns() };
  }, clientError));

  router.post("/api/flow/runs", requireApiKey, asyncHandler(async (req) => {
    const rt = runtime();
    const { workflow, inputs, run_id } = req.body || {};
    if (!workflow || typeof workflow !== "object") {
      throw new HttpError(400, { code: "FLOW_WORKFLOW_REQUIRED", message: "Missing 'workflow' document" });
    }
    try {
      const projection = await rt.startRun({ workflow, inputs: inputs || {}, run_id: run_id || null });
      return { ok: true, run: projection };
    } catch (err) {
      rethrowAsHttp(err);
    }
  }, clientError));

  router.get("/api/flow/runs/:runId", requireApiKey, asyncHandler(async (req) => {
    const rt = runtime();
    try {
      return { ok: true, run: await rt.getRun(req.params.runId) };
    } catch (err) {
      rethrowAsHttp(err);
    }
  }, clientError));

  router.post("/api/flow/runs/:runId/gate", requireApiKey, asyncHandler(async (req) => {
    const rt = runtime();
    const { gate_id, expected_gate_revision, decision, operator, comment, outputs } = req.body || {};
    if (!gate_id) throw new HttpError(400, { code: "FLOW_GATE_ID_REQUIRED", message: "Missing 'gate_id'" });
    if (!decision) throw new HttpError(400, { code: "FLOW_GATE_DECISION_REQUIRED", message: "Missing 'decision'" });
    try {
      const projection = await rt.resumeGate(req.params.runId, {
        gate_id,
        expected_gate_revision,
        decision,
        operator: operator || "unknown",
        comment,
        outputs: outputs || {},
      });
      return { ok: true, run: projection };
    } catch (err) {
      rethrowAsHttp(err);
    }
  }, clientError));

  return router;
};

// statusFor / STATUS_BY_CODE 不在这里再导出一次。加一个兼容导出，会让测试继续
// require 本模块，把 express 拖进本来不需要它的测试套件里，看着像修好了，债还在。
// lib/workflow/errorStatus.js 是唯一导入处。

