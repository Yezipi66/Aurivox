"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { startupKeyOf } = require("./residency")
const { buildHostProfile } = require("./hostProfile")

const profile = { weight_slots: [{ name: "model", applies_at: "launch" }] }

test("启动身份同时包含 launch weights 和显式 load 参数，且键序稳定", () => {
  const a = startupKeyOf(profile, { model: "/m/a" }, { use_fp16: false, device: "cuda" })
  const b = startupKeyOf(profile, { model: "/m/a" }, { device: "cuda", use_fp16: false })
  assert.equal(a, b)
  assert.notEqual(a, startupKeyOf(profile, { model: "/m/b" }, { device: "cuda", use_fp16: false }))
  assert.notEqual(a, startupKeyOf(profile, { model: "/m/a" }, { device: "cuda", use_fp16: true }))
})

test("未设置与显式 false/0 是不同启动身份", () => {
  const none = startupKeyOf({ weight_slots: [] }, {}, {})
  assert.equal(none, "")
  assert.notEqual(startupKeyOf({ weight_slots: [] }, {}, { use_fp16: false }), none)
  assert.notEqual(startupKeyOf({ weight_slots: [] }, {}, { workers: 0 }), none)
})

test("load 参数真实合并进 Host 构造参数", () => {
  const host = buildHostProfile("indextts2", {}, { loadParams: { use_fp16: false } })
  assert.equal(host.call.init_args.use_fp16, false)
})

test("Host 拒绝没有声明为 load_time 的启动参数", () => {
  assert.throws(
    () => buildHostProfile("indextts2", {}, { loadParams: { temperature: 0.7 } }),
    /未声明为 load_time/,
  )
})
