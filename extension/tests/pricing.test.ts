import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateUsageCostUsd,
  isMimoV25Usage,
  isMimoV25ProUsage,
  isGlm5Usage,
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

test("GLM-5.3 零费用按同 GLM-5.2 的按量价估算（8/28/缓存命中 2）", () => {
  const glm53 = estimateUsageCostUsd(
    { provider: "zai-coding-cn", model: "glm-5.3-high", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  // 8 + 28 + 2 + 8 = 46（与 GLM-5.2 同价）
  assert.ok(Math.abs(glm53 * USD_CNY_REFERENCE - 46) < 1e-6);
  // 仅输入：8 元
  const inputOnly = estimateUsageCostUsd(
    { provider: "zai", model: "glm-5.3", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    0,
  );
  assert.ok(Math.abs(inputOnly * USD_CNY_REFERENCE - 8) < 1e-6);
  // 识别函数：5.2 / 5.3 均命中；其他版本不误匹配
  assert.ok(isGlm5Usage("zai-coding-cn", "glm-5.3"));
  assert.ok(isGlm5Usage("zai", "glm-5.3-flash"));
  assert.ok(isGlm5Usage("zai-coding-cn", "glm-5.2-high"));
  assert.ok(!isGlm5Usage("zai", "glm-5"));
  assert.ok(!isGlm5Usage("zai", "glm-5.1"));
  assert.ok(!isGlm5Usage("zai", "glm-4.7"));
  assert.ok(!isGlm5Usage("deepseek", "glm-5.3"));
});
