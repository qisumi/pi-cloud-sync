/**
 * 服务器内部费用统一按 USD 保存。部分套餐渠道（GLM Coding Plan、
 * Xiaomi MiMo Token Plan）将模型价格上报为 0，因此使用厂商公开的国内按量价
 * 做估算，再按控制台构建时汇率换算。OpenAI 系列按官方美元价（Codex 会话
 * 提取的用量不带费用）。
 *
 * DeepSeek V4 自 2026-08-17 起峰谷计价：pi 的静态 cost 配置无法表达
 * 高峰/空闲差异且停留在旧平价，因此按 occurred_at 时间戳重算。
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

/** 智谱 GLM-5.3-Flash（开放平台按量价列表价，元/百万 tokens；缓存存储限时免费）。
 *  2026-09-09 前 5 折限时价 0.4/1.4/0.115，估算取列表价。需先于 GLM-5.2/5.3 合并规则匹配。 */
const GLM_53_FLASH_CNY_PER_MILLION = {
  input: 0.8,
  output: 2.8,
  cacheRead: 0.23,
  cacheWrite: 0,
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

/** OpenAI GPT-6 Astra（官方 API Standard 短上下文定价，美元/百万 tokens）
 *  来源：developers.openai.com/api/docs/pricing（2026-09）。
 *  长上下文（>272K）为 20/2/25/75；用量记录不含上下文长度，按短上下文计。 */
const GPT_6_ASTRA_USD_PER_MILLION = { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5 } as const;

/** OpenAI GPT-5.6 系列（官方 API Standard 短上下文定价，美元/百万 tokens）
 *  来源：developers.openai.com/api/docs/pricing（2026-09）。
 *  Sol 2026-08 起促销降价 $5/$30 → $4/$20（至少持续至 2026-11-21）；
 *  cacheWrite = 1.25 × input（官方规则）；Codex rollout 暂不报告 cacheWrite，保留以备将来提取。 */
const GPT_56_SOL_USD_PER_MILLION = { input: 4.0, output: 20.0, cacheRead: 0.4, cacheWrite: 5.0 } as const;
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

/** OpenAI GPT-6 Astra（新旗舰；gpt-6 别名路由到此）。按 model 精确匹配，忽略变体后缀。 */
export function isGpt6AstraUsage(_provider: string, model: string): boolean {
  return /^gpt[-_.]?6(?:$|[-_.]?astra$)/i.test(model.trim());
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

/* ---------------- DeepSeek V4 峰谷计价（2026-08-17 起） ---------------- */

/**
 * DeepSeek 峰谷计价生效时间：北京时间 2026-08-17 00:00（= UTC 2026-08-16 16:00）。
 * 之前的记录沿用旧平价（上报费用即为准确值），不做重算。
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

/**
 * 已知「套餐上报 0 费用」的模型及其公开按量价。
 * 顺序敏感：Pro / Flash 变体必须排在标准变体之前。
 */
const ESTIMATED_PRICING: EstimatedModelPricing[] = [
  { name: "MiMo v2.5 Pro", currency: "CNY", perMillion: MIMO_V25_PRO_CNY_PER_MILLION, match: isMimoV25ProUsage },
  { name: "MiMo v2.5", currency: "CNY", perMillion: MIMO_V25_CNY_PER_MILLION, match: isMimoV25Usage },
  { name: "GLM-5.3-Flash", currency: "CNY", perMillion: GLM_53_FLASH_CNY_PER_MILLION, match: isGlm53FlashUsage },
  { name: "GLM-5.2/5.3", currency: "CNY", perMillion: GLM_5X_CNY_PER_MILLION, match: isGlm5Usage },
  { name: "GPT-6 Astra", currency: "USD", perMillion: GPT_6_ASTRA_USD_PER_MILLION, match: isGpt6AstraUsage },
  { name: "GPT-5.6 Sol", currency: "USD", perMillion: GPT_56_SOL_USD_PER_MILLION, match: isGpt56SolUsage },
  { name: "GPT-5.6 Terra", currency: "USD", perMillion: GPT_56_TERRA_USD_PER_MILLION, match: isGpt56TerraUsage },
  { name: "GPT-5.6 Luna", currency: "USD", perMillion: GPT_56_LUNA_USD_PER_MILLION, match: isGpt56LunaUsage },
];

/**
 * 保留渠道上报的非零费用；仅为已知套餐模型的零费用记录按公开按量价提供估算。
 * DeepSeek V4 自 2026-08-17 起始终按时间戳峰谷重算（覆盖过期平价）。
 */
export function usageCostUsd(usage: UsageForPricing, reportedCost: number, ts: number = Date.now()): number {
  const deepseek = deepseekCostUsd(usage, ts);
  if (deepseek != null) return deepseek;
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
