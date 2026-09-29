import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateUsageCostUsd,
  isMimoV25Usage,
  isMimoV25ProUsage,
  isMimoV26FlashUsage,
  isMimoV26ProUsage,
  isGlm5Usage,
  isGlm52Usage,
  isGlm53FlashUsage,
  isGpt6AstraUsage,
  isGpt6SolUsage,
  isGpt6LunaUsage,
  isGpt56SolUsage,
  isGpt56LunaUsage,
  isDeepseekV4Usage,
  isDeepseekPeakHour,
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

test("MiMo v2.6 Flash / Pro 补算与识别（沿用 v2.5 定价，版本号互斥）", () => {
  // 国内按量价（元/百万 tokens）：v2.6 flash in1/out2/cr0.02/cw0；pro in3/out6/cr0.025
  const flash = estimateUsageCostUsd(
    { provider: "xiaomi-token-plan-cn", model: "mimo-v2.6-flash", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(flash * USD_CNY_REFERENCE - 3.02) < 1e-6);

  const pro = estimateUsageCostUsd(
    { provider: "xiaomi-token-plan-cn", model: "mimo-v2.6-pro", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(pro * USD_CNY_REFERENCE - 9.025) < 1e-6);

  // 识别：v2.6 与 v2.5 按版本号互斥；Pro 与非 Pro 互斥
  assert.ok(isMimoV26ProUsage("xiaomi-token-plan-cn", "mimo-v2.6-pro"));
  assert.ok(isMimoV26FlashUsage("xiaomi", "mimo-v2.6-flash"));
  assert.ok(!isMimoV26ProUsage("xiaomi", "mimo-v2.6-flash"));
  assert.ok(!isMimoV26FlashUsage("xiaomi", "mimo-v2.5"));
  assert.ok(!isMimoV25Usage("xiaomi", "mimo-v2.6-flash"));
  assert.ok(!isMimoV26ProUsage("deepseek", "mimo-v2.6-pro"));
  // 非 mimo-v2.6 不识别（如旧 mimo-v2-pro）
  assert.ok(!isMimoV26FlashUsage("xiaomi", "mimo-v2-pro"));
  // 渠道上报非零费用优先
  assert.equal(
    estimateUsageCostUsd({ provider: "xiaomi", model: "mimo-v2.6-flash", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5),
    0.5,
  );
});

test("GPT-6 Astra / Sol / Luna 与 GPT-5.6 系列按官方美元价补算（客户端与服务端口径一致）", () => {
  // 官方 Standard 短上下文价（美元/百万 tokens）；USD 直接返回，不经 USD_CNY_REFERENCE 折算
  const astra = estimateUsageCostUsd(
    { provider: "openai-codex", model: "gpt-6-astra", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(astra - 73.5) < 1e-9); // 10 + 50 + 1 + 12.5

  const sol = estimateUsageCostUsd(
    { provider: "openai-codex", model: "gpt-6-sol", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(sol - 14.7) < 1e-9); // 2 + 10 + 0.2 + 2.5

  const luna = estimateUsageCostUsd(
    { provider: "openai-codex", model: "gpt-6-luna", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  assert.ok(Math.abs(luna - 0.735) < 1e-9); // 0.1 + 0.5 + 0.01 + 0.125

  // gpt-6 别名路由到 Astra；无后缀 gpt-5.6 不匹配任何变体
  assert.ok(isGpt6AstraUsage("openai-codex", "gpt-6"));
  assert.ok(!isGpt6SolUsage("openai", "gpt-6"));
  assert.ok(!isGpt6LunaUsage("openai", "gpt-6-sol"));
  assert.ok(isGpt6SolUsage("openai", "gpt-6-sol"));
  assert.ok(isGpt6LunaUsage("codex", "gpt-6-luna"));
  // GPT-5.6 同名变体严格区分
  assert.ok(isGpt56SolUsage("openai", "gpt-5.6-sol"));
  assert.ok(!isGpt56LunaUsage("openai", "gpt-6-luna"));
  const luna56 = estimateUsageCostUsd(
    { provider: "openai", model: "gpt-5.6-luna", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    0,
  );
  assert.ok(Math.abs(luna56 - 0.2) < 1e-9);
  // 渠道上报非零费用优先
  assert.equal(
    estimateUsageCostUsd({ provider: "codex", model: "gpt-6-sol", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.3),
    0.3,
  );
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
  assert.ok(isGlm5Usage("zai", "glm-5.3-flash") === false); // flash 独立定价，不套 5.2/5.3 价
  assert.ok(isGlm5Usage("zai-coding-cn", "glm-5.2-high"));
  assert.ok(!isGlm5Usage("zai", "glm-5"));
  assert.ok(!isGlm5Usage("zai", "glm-5.1"));
  assert.ok(!isGlm5Usage("zai", "glm-4.7"));
  assert.ok(!isGlm5Usage("deepseek", "glm-5.3"));
});

test("GLM-5.3-Flash 按独立 1/10 定价估算（0.8/2.8/缓存命中 0.23），非 5.2/5.3 的 8/28", () => {
  const flash = estimateUsageCostUsd(
    { provider: "zai-coding-cn", model: "glm-5.3-flash", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    0,
  );
  // 0.8 + 2.8 + 0.23 + 0（缓存存储限时免费） = 3.83
  assert.ok(Math.abs(flash * USD_CNY_REFERENCE - 3.83) < 1e-6);
  // 仅输入：0.8 元
  const inputOnly = estimateUsageCostUsd(
    { provider: "zai", model: "glm-5.3-flash", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    0,
  );
  assert.ok(Math.abs(inputOnly * USD_CNY_REFERENCE - 0.8) < 1e-6);
  // 识别：zai 渠道 + glm-5.3-flash（含变体后缀）；非 zai 渠道不识别
  assert.ok(isGlm53FlashUsage("zai-coding-cn", "glm-5.3-flash"));
  assert.ok(isGlm53FlashUsage("zai", "glm-5.3-flash-highspeed"));
  assert.ok(!isGlm53FlashUsage("deepseek", "glm-5.3-flash"));
  assert.ok(!isGlm53FlashUsage("zai", "glm-5.3"));
  // 非零上报费用优先
  assert.equal(
    estimateUsageCostUsd({ provider: "zai", model: "glm-5.3-flash", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.01),
    0.01,
  );
});

test("DeepSeek V4 峰谷计价：按时间戳重算，覆盖过期的静态平价", () => {
  // 峰谷价（元/百万 tokens）：flash 高峰 3/9/0.1（空闲半价），pro 高峰 9/27/0.3
  // 北京 2026-09-01 周二 10:00 = UTC 02:00 → 高峰
  const peakTs = Date.UTC(2026, 8, 1, 2, 0, 0);
  // 北京 2026-09-01 周二 21:00 = UTC 13:00 → 空闲半价
  const offPeakTs = Date.UTC(2026, 8, 1, 13, 0, 0);

  const flashPeak = estimateUsageCostUsd(
    { provider: "deepseek", model: "deepseek-v4-flash", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 },
    0.0006,
    peakTs,
  );
  assert.ok(Math.abs(flashPeak * USD_CNY_REFERENCE - 12.1) < 1e-6); // 3 + 9 + 0.1
  // 上报的过期平价（0.0006）被覆盖，高峰约 5 倍
  assert.ok(flashPeak > 0.003);

  const flashOff = estimateUsageCostUsd(
    { provider: "deepseek", model: "deepseek-v4-flash", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 },
    0,
    offPeakTs,
  );
  assert.ok(Math.abs(flashOff * USD_CNY_REFERENCE - 6.05) < 1e-6);

  const proPeak = estimateUsageCostUsd(
    { provider: "deepseek", model: "deepseek-v4-pro", input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 },
    0,
    peakTs,
  );
  assert.ok(Math.abs(proPeak * USD_CNY_REFERENCE - 36.3) < 1e-6); // 9 + 27 + 0.3

  // vision-exp 与 flash 同价（周末空闲半价）
  const weekendTs = Date.UTC(2026, 8, 5, 2, 0, 0); // 北京周六 10:00
  const vision = estimateUsageCostUsd(
    { provider: "deepseek", model: "deepseek-v4-flash-vision-exp", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    0,
    weekendTs,
  );
  assert.ok(Math.abs(vision * USD_CNY_REFERENCE - 1.5) < 1e-6);

  // 峰谷生效前（北京 2026-08-17 之前）沿用旧平价：保留上报值 / 零则零
  const preTs = Date.UTC(2026, 7, 10, 2, 0, 0);
  assert.equal(
    estimateUsageCostUsd({ provider: "deepseek", model: "deepseek-v4-flash", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0.14, preTs),
    0.14,
  );
  assert.equal(
    estimateUsageCostUsd({ provider: "deepseek", model: "deepseek-v4-flash", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0, preTs),
    0,
  );
  // 旧模型不套峰谷价（沿用上报值）
  assert.equal(
    estimateUsageCostUsd({ provider: "deepseek", model: "deepseek-chat", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 0.2, peakTs),
    0.2,
  );
});

test("DeepSeek 高峰时段判定：北京时间工作日 9-12 / 14-18", () => {
  // 边界：9:00 含、12:00 不含、14:00 含、18:00 不含（均取周二）
  const tue = (bjHour: number, bjMin = 0) => Date.UTC(2026, 8, 1, bjHour - 8, bjMin, 0);
  assert.ok(isDeepseekPeakHour(tue(9)));
  assert.ok(isDeepseekPeakHour(tue(11, 59)));
  assert.ok(!isDeepseekPeakHour(tue(12)));
  assert.ok(!isDeepseekPeakHour(tue(13, 59)));
  assert.ok(isDeepseekPeakHour(tue(14)));
  assert.ok(isDeepseekPeakHour(tue(17, 59)));
  assert.ok(!isDeepseekPeakHour(tue(18)));
  assert.ok(!isDeepseekPeakHour(tue(8, 59)));
  // 周末全天空闲
  const sat = Date.UTC(2026, 8, 5, 2, 0, 0); // 北京周六 10:00
  const sun = Date.UTC(2026, 8, 6, 6, 0, 0); // 北京周日 14:00
  assert.ok(!isDeepseekPeakHour(sat));
  assert.ok(!isDeepseekPeakHour(sun));
  // 识别函数：v4 系列命中；旧模型 / 非 deepseek 渠道不命中
  assert.ok(isDeepseekV4Usage("deepseek", "deepseek-v4-flash"));
  assert.ok(isDeepseekV4Usage("deepseek", "deepseek-v4-pro"));
  assert.ok(isDeepseekV4Usage("deepseek", "deepseek-v4-flash-vision-exp"));
  assert.ok(!isDeepseekV4Usage("deepseek", "deepseek-chat"));
  assert.ok(!isDeepseekV4Usage("deepseek", "deepseek-reasoner"));
  assert.ok(!isDeepseekV4Usage("zai", "deepseek-v4-flash"));
  assert.ok(!isDeepseekV4Usage("openai", "gpt-6-astra"));
});
