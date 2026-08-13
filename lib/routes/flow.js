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
// The kernel's fail-closed codes carry real client meaning:
//
//   WORKFLOW_VALIDATION_FAILED        -> 400  the graph is wrong
//   GATE_REVISION_CONFLICT            -> 409  stale/duplicate review submission
//   WORKFLOW_INPUT_REBIND_REQUIRED    -> 409  process restarted, needs rebind
//   WORKFLOW_INPUT_REBIND_MISMATCH    -> 409  resolver disagreed with Journal
//   WORKFLOW_INPUT_ARTIFACT_CONFLICT  -> 409  Artifact Store disagreed
//   ARTIFACT_STORE_UNAVAILABLE        -> 503  infrastructure, retryable
//   RUN_NOT_FOUND / JOURNAL_NOT_FOUND -> 404

const express = require("express");
const { HttpError, asyncHandler } = require("../http/http");

const STATUS_BY_CODE = Object.freeze({
  // The validator's real code is WORKFLOW_INVALID. An earlier draft mapped a
  // guessed name (WORKFLOW_VALIDATION_FAILED) and therefore returned 500 for
  // every malformed graph — found by the first real end-to-end request.
  WORKFLOW_INVALID: 400,
  RUN_PLAN_MISMATCH: 409,
  GATE_REVISION_CONFLICT: 409,
  GATE_NOT_RESOLVABLE: 409,
  GATE_ALREADY_RESOLVED: 409,
  WORKFLOW_INPUT_REBIND_REQUIRED: 409,
  WORKFLOW_INPUT_REBIND_MISMATCH: 409,
  WORKFLOW_INPUT_ARTIFACT_CONFLICT: 409,
  FLOW_RUN_PLAN_UNAVAILABLE: 409,
  ARTIFACT_STORE_UNAVAILABLE: 503,
  NODE_HANDLER_NOT_FOUND: 501,
});

function statusFor(err) {
  if (err && err.status) return err.status;
  const code = err && err.code;
  if (code && STATUS_BY_CODE[code]) return STATUS_BY_CODE[code];
  if (code === "JOURNAL_NOT_FOUND" || code === "RUN_NOT_FOUND") return 404;
  return 500;
}

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

module.exports.STATUS_BY_CODE = STATUS_BY_CODE;
module.exports.statusFor = statusFor;
