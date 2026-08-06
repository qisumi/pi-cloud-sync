import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateUsageCostUsd,
  isMimoV25Usage,
  isMimoV25ProUsage,
  isGlm52Usage,
  USD_CNY_REFERENCE,
} from "../src/stats/pricing.js";

test("estimateUsageCostUsd: MiMo v2.5 / Pro 补算与 reportedCost 优先", () => {
  // 国内按量价（元/百万 tokens）：v2.5 in1/out2/cr0.02/cw0；pro in3/out6/cr0.025
  const v25 = estimateUsageCostUsd(
    {
      provider: "xiaomi-token-plan-cn",
      model: "mimo-v2.5",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    },
    0,
  );
  assert.ok(Math.abs(v25 * USD_CNY_REFERENCE - 3.02) < 1e-6);

  const pro = estimateUsageCostUsd(
    {
      provider: "xiaomi-token-plan-cn",
      model: "mimo-v2.5-pro",
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    },
    0,
  );
  assert.ok(Math.abs(pro * USD_CNY_REFERENCE - 9.025) < 1e-6);

  // 渠道上报非零费用优先，不被估算覆盖
  assert.equal(
    estimateUsageCostUsd({ provider: "xiaomi", model: "mimo-v2.5", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5),
    0.5,
  );
  // 未配价模型 → 0
  assert.equal(
    estimateUsageCostUsd({ provider: "openai", model: "gpt-4", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0),
    0,
  );
});

test("识别函数：Pro 与 v2.5 互斥，且要求 mimo 渠道", () => {
  assert.ok(isMimoV25ProUsage("xiaomi-token-plan-cn", "mimo-v2.5-pro"));
  assert.ok(!isMimoV25Usage("xiaomi-token-plan-cn", "mimo-v2.5-pro"));
  assert.ok(isMimoV25Usage("xiaomi-token-plan-cn", "mimo-v2.5"));
  assert.ok(!isMimoV25ProUsage("xiaomi-token-plan-cn", "mimo-v2.5"));
  // 非 mimo 渠道不识别
  assert.ok(!isMimoV25Usage("deepseek", "mimo-v2.5"));
  assert.ok(!isMimoV25ProUsage("deepseek", "mimo-v2.5-pro"));
  // 已下线 mimo-v2-pro 不识别
  assert.ok(!isMimoV25Usage("xiaomi", "mimo-v2-pro"));
  assert.ok(!isMimoV25ProUsage("xiaomi", "mimo-v2-pro"));
});

test("GLM-5.2 补算仍正常工作（回归保护）", () => {
  const glm = estimateUsageCostUsd(
    { provider: "zai-coding-cn", model: "glm-5.2-high", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(glm * USD_CNY_REFERENCE - 46) < 1e-6);
  assert.ok(isGlm52Usage("zai-coding-cn", "glm-5.2-high"));
});
