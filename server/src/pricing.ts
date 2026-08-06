/**
 * 服务器内部费用统一按 USD 保存。GLM-5.2 Coding Plan 的模型元数据将价格
 * 上报为 0，因此使用智谱开放平台公开的按量价做估算，再按控制台构建时汇率换算。
 */
export const USD_CNY_REFERENCE = 6.762932;

const GLM_52_CNY_PER_MILLION = {
  input: 8,
  output: 28,
  cacheRead: 2,
  cacheWrite: 8,
} as const;

export interface UsageForPricing {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function isGlm52Usage(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const isZai = normalizedProvider.includes("zai") || normalizedProvider.includes("zhipu") || normalizedProvider.includes("bigmodel");
  return isZai && /^glm[-_.]?5[.-]?2(?:$|[-_.])/.test(normalizedModel);
}

/** 保留渠道上报的非零费用；仅为 GLM-5.2 系列的零费用记录提供估算。 */
export function usageCostUsd(usage: UsageForPricing, reportedCost: number): number {
  if (Number.isFinite(reportedCost) && reportedCost > 0) return reportedCost;
  if (!isGlm52Usage(usage.provider, usage.model)) return 0;
  const cny =
    (usage.input * GLM_52_CNY_PER_MILLION.input +
      usage.output * GLM_52_CNY_PER_MILLION.output +
      usage.cacheRead * GLM_52_CNY_PER_MILLION.cacheRead +
      usage.cacheWrite * GLM_52_CNY_PER_MILLION.cacheWrite) /
    1_000_000;
  return cny / USD_CNY_REFERENCE;
}
