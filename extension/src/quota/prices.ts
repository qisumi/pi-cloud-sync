/**
 * 人民币参考价（¥/百万 tokens）——官网公开价格，仅供估算，会随时变动。
 *
 * 数据来源（2026-08 核实）：
 * - DeepSeek：官方开放平台公告（2026-05 起永久降价；高峰时段 9-12/14-18 价格 ×2）
 * - Z.AI 智谱：bigmodel.cn/pricing 旗舰文本模型（2026-08 抓取，含输入/输出/缓存命中）
 */
export interface CnyPriceModel {
  model: string;
  /** 输入（缓存未命中）¥/1M tokens */
  input: number;
  /** 输出 ¥/1M tokens */
  output: number;
  /** 输入缓存命中 ¥/1M tokens（可省略表示无公开价） */
  cacheHit?: number;
  /** 0 表示免费 */
  free?: boolean;
  note?: string;
}

export interface CnyPriceReference {
  provider: "deepseek" | "zai";
  label: string;
  /** 首个模型即主推模型（额度面板参考价显示用） */
  models: CnyPriceModel[];
  source: string;
  updated: string;
}

export const CNY_PRICES: Record<"deepseek" | "zai", CnyPriceReference> = {
  deepseek: {
    provider: "deepseek",
    label: "DeepSeek",
    models: [
      { model: "V4-Pro", input: 3, output: 6, cacheHit: 0.025, note: "高峰时段(9-12/14-18) ×2" },
      { model: "V4-Flash", input: 1, output: 2, cacheHit: 0.02 },
    ],
    source: "DeepSeek 官方开放平台公告",
    updated: "2026-06",
  },
  zai: {
    provider: "zai",
    label: "Z.AI 智谱",
    // 主推：GLM-4.7（编程主力，≤32k）；其余为 bigmodel.cn 全部旗舰文本模型
    models: [
      { model: "GLM-4.7", input: 2, output: 8, cacheHit: 0.4, note: "≤32k；32-200k: 入4/出16/缓存0.8" },
      { model: "GLM-5", input: 4, output: 18, cacheHit: 1, note: "≤32k" },
      { model: "GLM-5-Turbo", input: 5, output: 22, cacheHit: 1.2, note: "≤32k" },
      { model: "GLM-5.1", input: 6, output: 24, cacheHit: 1.3, note: "≤32k" },
      { model: "GLM-5.2", input: 8, output: 28, cacheHit: 2, note: "1M 上下文新品" },
      { model: "GLM-4.5-Air", input: 0.8, output: 2, cacheHit: 0.16 },
      { model: "GLM-4.7-FlashX", input: 0.5, output: 3, cacheHit: 0.1 },
      { model: "GLM-4.7-Flash", input: 0, output: 0, free: true },
    ],
    source: "智谱开放平台 bigmodel.cn/pricing",
    updated: "2026-08",
  },
};

/** 每个渠道取主推模型（第一个）生成一行简洁参考价文本 */
export function cnyPriceLine(): string {
  const parts: string[] = [];
  for (const ref of [CNY_PRICES.deepseek, CNY_PRICES.zai]) {
    const m = ref.models[0];
    if (m.free) {
      parts.push(`${ref.label} ${m.model} 免费`);
      continue;
    }
    const hit = m.cacheHit != null ? `/缓存${fmtYuan(m.cacheHit)}` : "";
    parts.push(`${ref.label} ${m.model} 入${fmtYuan(m.input)}/出${fmtYuan(m.output)}${hit}`);
  }
  return `参考价(¥/百万tokens): ${parts.join(" · ")}`;
}

function fmtYuan(n: number): string {
  return n < 1 ? String(n) : String(Math.round(n));
}
