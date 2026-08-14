/**
 * 服务器内部费用统一按 USD 保存。部分套餐渠道（GLM-5.2/5.3 Coding Plan、
 * Xiaomi MiMo Token Plan）将模型价格上报为 0，因此使用厂商公开的国内按量价
 * 做估算，再按控制台构建时汇率换算。
 */
export const USD_CNY_REFERENCE = 6.762932;

/** 估算定价：每百万 tokens 价格（CNY=国内按量价，USD=官方美元价） */
interface EstimatedModelPricing {
  /** 展示名，便于调试与日志 */
  name: string;
  /** 计价币种：CNY 按 USD_CNY_REFERENCE 折算为美元存储；USD 为官方美元价直接存储 */
  currency: "CNY" | "USD";
  perMillion: { input: number; output: number; cacheRead: number; cacheWrite: number };
  match: (provider: string, model: string) => boolean;
}

/** 智谱 GLM-5.2 / 5.3（开放平台按量价一致，元/百万 tokens；GLM-5.3 沿用 5.2 定价 8/28/缓存命中 2） */
const GLM_5X_CNY_PER_MILLION = {
  input: 8,
  output: 28,
  cacheRead: 2,
  cacheWrite: 8,
} as const;

/** 小米 MiMo v2.5（国内按量价，元/百万 tokens；缓存写入限时免费） */
const MIMO_V25_CNY_PER_MILLION = {
  input: 1,
  output: 2,
  cacheRead: 0.02,
  cacheWrite: 0,
} as const;

/** 小米 MiMo v2.5 Pro（国内按量价，元/百万 tokens；缓存写入限时免费） */
const MIMO_V25_PRO_CNY_PER_MILLION = {
  input: 3,
  output: 6,
  cacheRead: 0.025,
  cacheWrite: 0,
} as const;

/** OpenAI GPT-5.6 系列（官方 API Standard 短上下文定价，美元/百万 tokens）
 *  来源：developers.openai.com/api/docs/pricing（2026-07）。
 *  cacheWrite = 1.25 × input（官方规则）；Codex rollout 暂不报告 cacheWrite，保留以备将来提取。 */
const GPT_56_SOL_USD_PER_MILLION = { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite: 6.25 } as const;
const GPT_56_TERRA_USD_PER_MILLION = { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite: 2.5 } as const;
const GPT_56_LUNA_USD_PER_MILLION = { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 } as const;

export interface UsageForPricing {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** GLM-5.2 / 5.3（同价，合并匹配） */
export function isGlm5Usage(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const isZai = normalizedProvider.includes("zai") || normalizedProvider.includes("zhipu") || normalizedProvider.includes("bigmodel");
  return isZai && /^glm[-_.]?5(?:[.-]?2|[.-]?3)(?:$|[-_.])/.test(normalizedModel);
}

/** @deprecated 兼容旧导出名，等价于 isGlm5Usage（GLM-5.2/5.3 同价）。 */
export const isGlm52Usage = isGlm5Usage;

/** MiMo v2.5 Pro（小米）：套餐接入时 cost 上报为 0。需先于 v2.5 匹配。 */
export function isMimoV25ProUsage(provider: string, model: string): boolean {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  const isMimo = p.includes("xiaomi") || p.includes("mimo");
  return isMimo && m.includes("mimo") && m.includes("v2.5") && m.includes("pro");
}

/** MiMo v2.5（小米，非 Pro） */
export function isMimoV25Usage(provider: string, model: string): boolean {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  const isMimo = p.includes("xiaomi") || p.includes("mimo");
  return isMimo && m.includes("mimo") && m.includes("v2.5") && !m.includes("pro");
}

/** OpenAI GPT-5.6 Sol（前沿模型；gpt-5.6 别名路由到此）。按 model 精确匹配，忽略变体后缀。 */
export function isGpt56SolUsage(_provider: string, model: string): boolean {
  return /^gpt[-_.]?5[.-]?6[-_.]?sol$/i.test(model.trim());
}

/** OpenAI GPT-5.6 Terra */
export function isGpt56TerraUsage(_provider: string, model: string): boolean {
  return /^gpt[-_.]?5[.-]?6[-_.]?terra$/i.test(model.trim());
}

/** OpenAI GPT-5.6 Luna */
export function isGpt56LunaUsage(_provider: string, model: string): boolean {
  return /^gpt[-_.]?5[.-]?6[-_.]?luna$/i.test(model.trim());
}

/**
 * 已知「套餐上报 0 费用」的模型及其公开按量价。
 * 顺序敏感：Pro 变体必须排在标准 v2.5 之前（标准变体已排除 pro，此处双保险）。
 */
const ESTIMATED_PRICING: EstimatedModelPricing[] = [
  { name: "MiMo v2.5 Pro", currency: "CNY", perMillion: MIMO_V25_PRO_CNY_PER_MILLION, match: isMimoV25ProUsage },
  { name: "MiMo v2.5", currency: "CNY", perMillion: MIMO_V25_CNY_PER_MILLION, match: isMimoV25Usage },
  { name: "GLM-5.2/5.3", currency: "CNY", perMillion: GLM_5X_CNY_PER_MILLION, match: isGlm5Usage },
  { name: "GPT-5.6 Sol", currency: "USD", perMillion: GPT_56_SOL_USD_PER_MILLION, match: isGpt56SolUsage },
  { name: "GPT-5.6 Terra", currency: "USD", perMillion: GPT_56_TERRA_USD_PER_MILLION, match: isGpt56TerraUsage },
  { name: "GPT-5.6 Luna", currency: "USD", perMillion: GPT_56_LUNA_USD_PER_MILLION, match: isGpt56LunaUsage },
];

/**
 * 保留渠道上报的非零费用；仅为已知套餐模型（MiMo v2.5 系列 / GLM-5.2/5.3）的
 * 零费用记录按公开按量价提供估算。
 */
export function usageCostUsd(usage: UsageForPricing, reportedCost: number): number {
  if (Number.isFinite(reportedCost) && reportedCost > 0) return reportedCost;
  for (const pricing of ESTIMATED_PRICING) {
    if (pricing.match(usage.provider, usage.model)) {
      const amount =
        (usage.input * pricing.perMillion.input +
          usage.output * pricing.perMillion.output +
          usage.cacheRead * pricing.perMillion.cacheRead +
          usage.cacheWrite * pricing.perMillion.cacheWrite) /
        1_000_000;
      // CNY 按量价需折算为美元；USD 官方价直接返回
      return pricing.currency === "USD" ? amount : amount / USD_CNY_REFERENCE;
    }
  }
  return 0;
}
