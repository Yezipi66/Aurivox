// ===========================
//  Aurivox Flow: kernel error code -> HTTP status (FLOW-D28)
// ===========================
// This module exists for one structural reason, recorded here so it is not
// "tidied" back into the route later:
//
//   statusFor() is a pure function of an error object. It used to live in
//   lib/routes/flow.js, which requires express at module top level. Because
//   lib/workflow/runtime.node.test.js imports statusFor, the whole unit suite
//   became unloadable wherever express is not installed -- a hard RED
//   (MODULE_NOT_FOUND), not a skip with a reason, contradicting the discipline
//   FLOW-CORE-004 wrote down for itself.
//
//   The failure did not show up as a colour. It showed up as the TOTAL:
//     no node_modules: 191 tests / 161 pass / 1 fail / 29 skipped
//                      191 + 12 - 1 = 202   (a suite that fails to LOAD
//                                            contributes 1 failure, and its
//                                            12 tests are never counted)
//
// Therefore this file MUST stay dependency-free. It requires nothing, not even
// node builtins. Adding any require() here re-creates FLOW-D28, and is pinned
// by a test that reads this file's own source.
//
// Mapping rationale (why not "everything is 500"): the kernel's fail-closed
// codes carry real client meaning.
//
//   WORKFLOW_INVALID                  -> 400  the graph is wrong
//   GATE_REVISION_CONFLICT            -> 409  stale/duplicate review submission
//   WORKFLOW_INPUT_REBIND_REQUIRED    -> 409  process restarted, needs rebind
//   WORKFLOW_INPUT_REBIND_MISMATCH    -> 409  resolver disagreed with Journal
//   WORKFLOW_INPUT_ARTIFACT_CONFLICT  -> 409  Artifact Store disagreed
//   ARTIFACT_STORE_UNAVAILABLE        -> 503  infrastructure, retryable
//   RUN_NOT_FOUND / JOURNAL_NOT_FOUND -> 404
//
// FLOW-CORE-004 D-2: an earlier draft mapped a GUESSED code name
// (WORKFLOW_VALIDATION_FAILED) while the validator actually throws
// WORKFLOW_INVALID, so every malformed graph returned 500 instead of 400.
// Only a real end-to-end request found it: a code that exists only in the
// mapping table is the same as no mapping at all.

const STATUS_BY_CODE = Object.freeze({
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

module.exports = { STATUS_BY_CODE, statusFor };
