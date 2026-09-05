/**
 * 用量费用补算（客户端 /qisumi-usage 视图）。
 *
 * pi 按模型 cost 配置计算 usage.cost.total；部分套餐渠道（GLM Coding Plan、
 * Xiaomi MiMo Token Plan）把模型价格上报为 0，导致 pi 算出的费用恒为 0。
 * 这里按厂商公开的国内按量价做估算，再按固定汇率换算成 USD，与
 * server/src/pricing.ts 保持一致——确保客户端与控制台金额口径统一。
 *
 * 仅当渠道上报费用为 0 / 缺失时才估算；非零费用原样保留，绝不覆盖。
 * 例外：DeepSeek V4 自 2026-08-17 起峰谷计价，pi 的静态 cost 配置无法
 * 表达高峰/空闲差异且仍停留在旧平价，因此按时间戳重算（见 deepseekCostUsd）。
 */
export const USD_CNY_REFERENCE = 6.762932;

interface EstimatedModelPricing {
  name: string;
  cnyPerMillion: { input: number; output: number; cacheRead: number; cacheWrite: number };
  match: (provider: string, model: string) => boolean;
}

/** 智谱 GLM-5.2 / 5.3（开放平台按量价一致，元/百万 tokens；GLM-5.3 沿用 5.2 定价 8/28/缓存命中 2） */
const GLM_5X_CNY_PER_MILLION = { input: 8, output: 28, cacheRead: 2, cacheWrite: 8 } as const;

/** 智谱 GLM-5.3-Flash（开放平台按量价列表价，元/百万 tokens；缓存存储限时免费。
 *  2026-09-09 前 5 折限时价 0.4/1.4/0.115，估算取列表价。需先于 GLM-5.2/5.3 合并规则匹配。 */
const GLM_53_FLASH_CNY_PER_MILLION = { input: 0.8, output: 2.8, cacheRead: 0.23, cacheWrite: 0 } as const;

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

/** GLM-5.3-Flash（智谱，原生多模态，已全量上线 Coding Plan）。需先于 GLM-5.2/5.3 匹配。 */
export function isGlm53FlashUsage(provider: string, model: string): boolean {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const isZai = normalizedProvider.includes("zai") || normalizedProvider.includes("zhipu") || normalizedProvider.includes("bigmodel");
  return isZai && /^glm[-_.]?5[.-]?3[-_.]?flash(?:$|[-_.])/.test(normalizedModel);
}

/** GLM-5.2 / 5.3（同价，合并匹配；不含 5.3-flash——flash 独立定价为其 1/10） */
export function isGlm5Usage(provider: string, model: string): boolean {
  if (isGlm53FlashUsage(provider, model)) return false;
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

/* ---------------- DeepSeek V4 峰谷计价（2026-08-17 起） ---------------- */

/**
 * DeepSeek 峰谷计价生效时间：北京时间 2026-08-17 00:00（= UTC 2026-08-16 16:00）。
 * 之前的记录沿用旧平价（pi 上报费用即为准确值），不做重算。
 */
export const DEEPSEEK_PEAK_PRICING_SINCE_MS = Date.UTC(2026, 7, 16, 16, 0, 0);

/** DeepSeek V4 峰谷价（元/百万 tokens）：工作日 9-12 / 14-18（北京时间）高峰，空闲半价。
 *  v4-flash-vision-exp 与 v4-flash 同价；无缓存写入费。 */
const DEEPSEEK_V4_FLASH_PEAK_CNY_PER_MILLION = { input: 3.0, output: 9.0, cacheRead: 0.1 } as const;
const DEEPSEEK_V4_PRO_PEAK_CNY_PER_MILLION = { input: 9.0, output: 27.0, cacheRead: 0.3 } as const;

/** DeepSeek V4 系列识别：仅限官方 deepseek 渠道（第三方中转自有计价，不套官方峰谷价）。
 *  model 需为 v4 系列（v4-flash / v4-flash-vision-exp / v4-pro）。 */
export function isDeepseekV4Usage(provider: string, model: string): boolean {
  const p = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  if (!p.includes("deepseek")) return false;
  return /^deepseek[-_.]?v4/.test(m);
}

/** 判断时间戳是否落在 DeepSeek 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00。 */
export function isDeepseekPeakHour(ts: number): boolean {
  // 北京时间 = UTC+8，用 UTC 字段避免本机时区影响
  const bj = new Date(ts + 8 * 3600_000);
  const day = bj.getUTCDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return false;
  const hour = bj.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/**
 * DeepSeek V4 按时间戳的峰谷费用（USD）。
 * 返回 null 表示不适用（非 V4 模型，或早于 2026-08-17 峰谷生效）。
 * 注意：无论渠道是否上报费用都以此重算——pi 的静态 cost 配置停在旧平价
 * （flash 0.14/0.28 USD），无法表达峰谷，且高峰低估约 3-5 倍。
 */
export function deepseekCostUsd(usage: UsageForPricing, ts: number): number | null {
  if (!isDeepseekV4Usage(usage.provider, usage.model)) return null;
  if (ts < DEEPSEEK_PEAK_PRICING_SINCE_MS) return null;
  const m = usage.model.trim().toLowerCase();
  const peakTable = m.includes("pro") ? DEEPSEEK_V4_PRO_PEAK_CNY_PER_MILLION : DEEPSEEK_V4_FLASH_PEAK_CNY_PER_MILLION;
  const factor = isDeepseekPeakHour(ts) ? 1 : 0.5; // 空闲时段半价
  const cny =
    (usage.input * peakTable.input + usage.output * peakTable.output + usage.cacheRead * peakTable.cacheRead) *
    factor /
    1_000_000;
  return cny / USD_CNY_REFERENCE;
}

/** 顺序敏感：Pro / Flash 变体必须排在标准变体之前。 */
const ESTIMATED_PRICING: EstimatedModelPricing[] = [
  { name: "MiMo v2.5 Pro", cnyPerMillion: MIMO_V25_PRO_CNY_PER_MILLION, match: isMimoV25ProUsage },
  { name: "MiMo v2.5", cnyPerMillion: MIMO_V25_CNY_PER_MILLION, match: isMimoV25Usage },
  { name: "GLM-5.3-Flash", cnyPerMillion: GLM_53_FLASH_CNY_PER_MILLION, match: isGlm53FlashUsage },
  { name: "GLM-5.2/5.3", cnyPerMillion: GLM_5X_CNY_PER_MILLION, match: isGlm5Usage },
];

/**
 * 渠道上报费用非零则保留；否则按已知套餐模型（MiMo v2.5 系列 / GLM-5.x）的
 * 公开按量价估算，返回 USD。
 * DeepSeek V4 自 2026-08-17 起始终按时间戳峰谷重算（覆盖过期平价）。
 */
export function estimateUsageCostUsd(usage: UsageForPricing, reportedCost: number, ts: number = Date.now()): number {
  const deepseek = deepseekCostUsd(usage, ts);
  if (deepseek != null) return deepseek;
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
