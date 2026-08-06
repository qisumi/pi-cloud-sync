/**
 * 用量费用补算（客户端 /qisumi-usage 视图）。
 *
 * pi 按模型 cost 配置计算 usage.cost.total；部分套餐渠道（GLM-5.2 Coding
 * Plan、Xiaomi MiMo Token Plan）把模型价格上报为 0，导致 pi 算出的费用恒为
 * 0。这里按厂商公开的国内按量价做估算，再按固定汇率换算成 USD，与
 * server/src/pricing.ts 保持一致——确保客户端与控制台金额口径统一。
 *
 * 仅当渠道上报费用为 0 / 缺失时才估算；非零费用原样保留，绝不覆盖。
 */
export const USD_CNY_REFERENCE = 6.762932;

interface EstimatedModelPricing {
  name: string;
  cnyPerMillion: { input: number; output: number; cacheRead: number; cacheWrite: number };
  match: (provider: string, model: string) => boolean;
}

/** 智谱 GLM-5.2（开放平台按量价，元/百万 tokens） */
const GLM_52_CNY_PER_MILLION = { input: 8, output: 28, cacheRead: 2, cacheWrite: 8 } as const;

/** 小米 MiMo v2.5（国内按量价，元/百万 tokens；缓存写入限时免费） */
const MIMO_V25_CNY_PER_MILLION = { input: 1, output: 2, cacheRead: 0.02, cacheWrite: 0 } as const;

/** 小米 MiMo v2.5 Pro（国内按量价，元/百万 tokens；缓存写入限时免费） */
const MIMO_V25_PRO_CNY_PER_MILLION = { input: 3, output: 6, cacheRead: 0.025, cacheWrite: 0 } as const;

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

/** 顺序敏感：Pro 变体必须排在标准 v2.5 之前（标准变体已排除 pro，此处双保险）。 */
const ESTIMATED_PRICING: EstimatedModelPricing[] = [
  { name: "MiMo v2.5 Pro", cnyPerMillion: MIMO_V25_PRO_CNY_PER_MILLION, match: isMimoV25ProUsage },
  { name: "MiMo v2.5", cnyPerMillion: MIMO_V25_CNY_PER_MILLION, match: isMimoV25Usage },
  { name: "GLM-5.2", cnyPerMillion: GLM_52_CNY_PER_MILLION, match: isGlm52Usage },
];

/**
 * 渠道上报费用非零则保留；否则按已知套餐模型（MiMo v2.5 系列 / GLM-5.2）的
 * 公开按量价估算，返回 USD。
 */
export function estimateUsageCostUsd(usage: UsageForPricing, reportedCost: number): number {
  if (Number.isFinite(reportedCost) && reportedCost > 0) return reportedCost;
  for (const pricing of ESTIMATED_PRICING) {
    if (pricing.match(usage.provider, usage.model)) {
      const cny =
        (usage.input * pricing.cnyPerMillion.input +
          usage.output * pricing.cnyPerMillion.output +
          usage.cacheRead * pricing.cnyPerMillion.cacheRead +
          usage.cacheWrite * pricing.cnyPerMillion.cacheWrite) /
        1_000_000;
      return cny / USD_CNY_REFERENCE;
    }
  }
  return 0;
}
