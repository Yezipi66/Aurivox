// ===========================
//  ROUTES: Aurivox Flow (FLOW-CORE-004 live wiring)
// ===========================
// HTTP surface for the Flow kernel. Mounted ONLY when FLOW_ENABLED is set, so
// the default server behaviour is byte-for-byte what it was before wiring.
//
// The route is a thin adapter: it translates HTTP <-> FlowRuntime and maps
// kernel error codes onto status codes. It contains no scheduling, no
// synthesis and no Journal logic.
//
// Error mapping is deliberately explicit rather than "everything is 500".
// The table itself lives in lib/workflow/errorStatus.js and NOT here: it is a
// pure function, and keeping it behind this module's top-level
// require("express") is what made the Flow unit suite fail to load (RED, not
// skip) wherever dependencies are absent — FLOW-D28. See that file's header
// for the mapping rationale and for why it must stay dependency-free.

const express = require("express");
const { HttpError, asyncHandler } = require("../http/http");
const { statusFor } = require("../workflow/errorStatus");

// Kernel errors carry structured diagnostics that are safe to expose: FLOW-D10
// R1 §Q3 guarantees rebind diagnostics contain digests/lengths, never plaintext.
function bodyFor(err) {
  const out = {
    code: (err && err.code) || "FLOW_INTERNAL_ERROR",
    message: (err && err.message) || String(err),
  };
  if (err && err.retryable !== undefined) out.retryable = err.retryable === true;
  if (err && Array.isArray(err.mismatches)) out.mismatches = err.mismatches;
  if (err && Array.isArray(err.conflicts)) out.conflicts = err.conflicts;
  if (err && Array.isArray(err.issues)) out.issues = err.issues;
  // WorkflowValidationError carries the per-node issue list under `errors`.
  // Without it a 400 tells the caller nothing about WHICH node is wrong.
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

  // Guard: the router is only mounted when a runtime exists, but keep an
  // explicit 503 rather than a TypeError if that ever changes.
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

// FLOW-D28: statusFor / STATUS_BY_CODE are deliberately NOT re-exported here.
// A compatibility re-export would let a test keep requiring this module — and
// therefore keep dragging express into a suite that does not need it, leaving
// the debt in place while looking fixed. lib/workflow/errorStatus.js is the
// single import site. Nothing outside this file consumed these exports:
// server.js:1762-1765 depends on the router factory only.
