// 内核错误码 → HTTP 状态码的映射（契约 FLOW-D28）。
// 本文件必须零依赖：连 node 内置模块也不要 require。workflow 的单测要 import
// statusFor，顶层 require 会把整组用例拖成 MODULE_NOT_FOUND 的硬失败，
// 有一个测试直接读本文件的源码来钉这条。
// 表里只能写真实存在的错误码：只存在于表里的名字等于没有映射。

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
