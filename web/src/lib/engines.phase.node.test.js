import test from "node:test"
import assert from "node:assert/strict"
import { paramsByPhase } from "./engines.js"

const engine = {
  param_schema: [
    { name: "temperature", type: "number", phase: "call" },
    { name: "use_fp16", type: "boolean", phase: "load" },
  ],
}

test("显式参数按 call/load 分流，false 不丢失", () => {
  const got = paramsByPhase(engine, { temperature: 0.7, use_fp16: false }, new Set(["temperature", "use_fp16"]))
  assert.deepEqual(got, { call: { temperature: 0.7 }, load: { use_fp16: false } })
})

test("未触碰的 load 建议值不会进入启动配置", () => {
  const got = paramsByPhase(engine, { temperature: 0.7, use_fp16: true }, new Set(["temperature"]))
  assert.deepEqual(got, { call: { temperature: 0.7 }, load: {} })
})
